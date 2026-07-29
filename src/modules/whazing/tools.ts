import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import logger from "@/api/lib/logger";
import {
  DEFAULT_TIMEZONE,
  formatHumanDateTime,
  formatWithPattern,
  roundDownToMinutes,
} from "@/graph/time";
import { CalculatorError, evaluateExpression } from "@/graph/tools/calculator";
import type { WhazingClient } from "./client";

// Whazing-native tools that mirror the subset of Chatwoot native tools supported by the
// WhazingClient. Uses the same tool names so the agent editor's native tool allowlist works
// without a new catalog. Chatwoot-only tools (set_custom_attribute, assign_label, kanban_*,
// set_voice_preference, react_to_message) are omitted — not available on Whazing.

export interface WhazingToolCtx {
  client: WhazingClient;
  ticketId: number;
  timezone?: string;
  toolInstructions?: Partial<Record<string, string>>;
}

function handoffToHumanTool(ctx: WhazingToolCtx) {
  return tool(
    async ({
      reason,
      queueId,
      customerMessage,
    }: {
      reason?: string;
      queueId?: number;
      customerMessage?: string;
    }) => {
      if (customerMessage?.trim()) {
        try {
          await ctx.client.sendMessage(ctx.ticketId, customerMessage.trim());
        } catch (e) {
          logger.warn(
            "whazing handoff customer message failed (ticket=%s): %s",
            String(ctx.ticketId),
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      if (reason) {
        try {
          await ctx.client.sendPrivateNote(ctx.ticketId, reason);
        } catch (e) {
          logger.warn(
            "whazing handoff private note failed (ticket=%s): %s",
            String(ctx.ticketId),
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      if (queueId != null) {
        try {
          await ctx.client.assignTicketToQueue(ctx.ticketId, queueId);
          return `Handed off to a human (assigned to queue ${queueId}). The bot will stay silent now.`;
        } catch (e) {
          logger.warn(
            "whazing handoff queue assignment failed (ticket=%s queue=%s): %s",
            String(ctx.ticketId),
            String(queueId),
            e instanceof Error ? e.message : String(e),
          );
          return "Handed off to a human. Queue assignment failed — the ticket stays in default routing. The bot will stay silent now.";
        }
      }
      return "Handed off to a human. The bot will stay silent now.";
    },
    {
      name: "handoff_to_human",
      description: [
        "Escalate the ticket to a human agent. Optionally provide a queue ID to route to a specific queue, a short summary (posted as a private note), and a customer-facing message to send before transferring. Before transferring, set `customerMessage` to a brief reply to the customer (e.g. that a human will continue) so they are not left without an answer.",
        ctx.toolInstructions?.handoff_to_human?.trim()
          ? `Operator guidance: ${ctx.toolInstructions.handoff_to_human.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: z.object({
        reason: z
          .string()
          .optional()
          .describe("Short private-note summary for the human taking over."),
        queueId: z
          .number()
          .int()
          .optional()
          .describe(
            "Whazing queue ID to assign the ticket to. Omit to leave in default routing.",
          ),
        customerMessage: z
          .string()
          .optional()
          .describe(
            "A short message to the customer sent before the transfer. Strongly recommended.",
          ),
      }),
    },
  );
}

function privateNoteTool(ctx: WhazingToolCtx) {
  return tool(
    async ({ content }: { content: string }) => {
      await ctx.client.sendPrivateNote(ctx.ticketId, content);
      return "Private note posted.";
    },
    {
      name: "private_note",
      description:
        "Leave an internal note on the ticket (NOT visible to the customer). Use to record context for the human team. To escalate to a human right now, use handoff_to_human instead.",
      schema: z.object({ content: z.string().min(1) }),
    },
  );
}

function resolveConversationTool(ctx: WhazingToolCtx) {
  return tool(
    async () => {
      await ctx.client.closeTicket(ctx.ticketId);
      return "Ticket closed.";
    },
    {
      name: "resolve_conversation",
      description:
        "Close the ticket when the customer's request is fully handled.",
      schema: z.object({}),
    },
  );
}

function skipReplyTool() {
  return tool(
    async ({ reason }: { reason?: string }) => {
      return reason
        ? `Acknowledged: not replying this turn (${reason}). Produce no message now.`
        : "Acknowledged: not replying this turn. Produce no message now.";
    },
    {
      name: "skip_reply",
      description:
        "Decide NOT to send any reply this turn. Use ONLY when a reply would add nothing — e.g. the customer sent just an acknowledgement ('ok', 'blz', 'obrigado') or a bare emoji.",
      schema: z.object({
        reason: z
          .string()
          .optional()
          .describe("Short reason for not replying."),
      }),
    },
  );
}

function calculatorTool() {
  return tool(
    async ({ expression }: { expression: string }) => {
      try {
        const value = evaluateExpression(expression);
        return `${expression} = ${value}`;
      } catch (e) {
        const reason = e instanceof CalculatorError ? e.message : "invalid";
        return `Could not evaluate "${expression}" (${reason}).`;
      }
    },
    {
      name: "calculator",
      description:
        "Evaluate an arithmetic expression exactly (supports + - * / % ^ and parentheses). Use for any math instead of computing it yourself.",
      schema: z.object({
        expression: z
          .string()
          .min(1)
          .describe("Arithmetic expression, e.g. (12.5 * 3) + 2^4."),
      }),
    },
  );
}

function getCurrentTimeTool(ctx: WhazingToolCtx) {
  return tool(
    async ({ roundToMinutes }: { roundToMinutes?: number }) => {
      const tz = ctx.timezone || DEFAULT_TIMEZONE;
      const now =
        roundToMinutes && roundToMinutes > 0
          ? roundDownToMinutes(new Date(), roundToMinutes)
          : new Date();
      const iso = formatWithPattern(now, tz, "YYYY-MM-DD HH:mm");
      return `${formatHumanDateTime(now, tz)} (${iso}, ${tz})`;
    },
    {
      name: "get_current_time",
      description:
        "Get the current date and time in the agent's timezone. Use when the customer asks about today's date, the current time, or scheduling relative to 'now'.",
      schema: z.object({
        roundToMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optionally floor the time to this many minutes, e.g. 30."),
      }),
    },
  );
}

// Supported Whazing native tool names (subset of the global NATIVE_TOOL_NAMES catalog).
export const WHAZING_NATIVE_TOOL_NAMES = [
  "handoff_to_human",
  "private_note",
  "resolve_conversation",
  "skip_reply",
  "calculator",
  "get_current_time",
] as const;

export type WhazingNativeToolName = (typeof WHAZING_NATIVE_TOOL_NAMES)[number];

export function buildWhazingNativeTools(
  ctx: WhazingToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    handoffToHumanTool(ctx),
    privateNoteTool(ctx),
    resolveConversationTool(ctx),
    skipReplyTool(),
    calculatorTool(),
    getCurrentTimeTool(ctx),
  ];
  if (!allowed) return all;
  const allow = new Set(allowed);
  return all.filter((t) => allow.has(t.name));
}
