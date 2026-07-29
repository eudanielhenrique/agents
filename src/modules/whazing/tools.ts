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
import type { WhazingClient, WhazingDynamicChoice } from "./client";
import type { WhazingPixConfig } from "./payments";

// Whazing-native tools that mirror the subset of Chatwoot native tools supported by the
// WhazingClient. Uses the same tool names so the agent editor's native tool allowlist works
// without a new catalog. Chatwoot-only tools (set_custom_attribute, assign_label,
// set_voice_preference, react_to_message) are omitted — not available on Whazing.
// Kanban tools ARE available via the Whazing Kanban Pro API (/kanbanpro/*).

export interface WhazingToolCtx {
  client: WhazingClient;
  ticketId: number;
  contactId?: number;
  timezone?: string;
  toolInstructions?: Partial<Record<string, string>>;
  // Operator-configured PIX key for send_pix_button / request_payment. null ⇒ those tools decline
  // (they never accept a model-supplied key — see payments.ts).
  pixConfig?: WhazingPixConfig | null;
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

function kanbanMoveCardTool(ctx: WhazingToolCtx) {
  const hint = ctx.toolInstructions?.kanban_move_card?.trim();
  return tool(
    async ({
      boardId,
      columnId,
      note,
      priority,
    }: {
      boardId: number;
      columnId: number;
      note?: string;
      priority?: "none" | "low" | "medium" | "high" | "urgent";
    }) => {
      if (ctx.contactId == null) {
        return "Cannot move kanban card: contact ID not available for this ticket.";
      }
      await ctx.client.kanbanCreateOrMove({
        boardId,
        columnId,
        contactId: ctx.contactId,
        note,
        priority,
      });
      return `Card moved to column ${columnId} on board ${boardId}.`;
    },
    {
      name: "kanban_move_card",
      description: [
        "Move (or create) the contact's kanban card to a specific column in the funnel. Use action create_or_move — creates the card if the contact has none on the board, otherwise moves it. Always specify boardId and columnId (integer IDs). Optionally add a note explaining the move and a priority level.",
        hint ? `Operator guidance: ${hint}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: z.object({
        boardId: z.number().int().positive().describe("Kanban board ID."),
        columnId: z.number().int().positive().describe("Target column ID to move the card to."),
        note: z.string().optional().describe("Short note explaining why the card is being moved."),
        priority: z
          .enum(["none", "low", "medium", "high", "urgent"])
          .optional()
          .describe("Card priority. Omit to keep existing priority."),
      }),
    },
  );
}

function updateKanbanTaskTool(ctx: WhazingToolCtx) {
  const hint = ctx.toolInstructions?.update_kanban_task?.trim();
  return tool(
    async ({
      boardId,
      title,
      priority,
      columnId,
      note,
      dueDate,
    }: {
      boardId: number;
      title?: string;
      priority?: "none" | "low" | "medium" | "high" | "urgent";
      columnId?: number;
      note?: string;
      dueDate?: string;
    }) => {
      if (ctx.contactId == null) {
        return "Cannot update kanban card: contact ID not available for this ticket.";
      }
      // Find the contact's existing card on this board.
      const cards = (await ctx.client.kanbanGetContactCards(ctx.contactId)) as
        | Array<{ id: number; boardId: number }>
        | unknown;
      const list = Array.isArray(cards) ? cards : [];
      const card = list.find((c) => c.boardId === boardId);
      if (!card) {
        return `No kanban card found for this contact on board ${boardId}. Use kanban_move_card to create one first.`;
      }
      await ctx.client.kanbanUpdateCard(card.id, {
        title,
        priority,
        columnId,
        note,
        dueDate,
      });
      return `Kanban card ${card.id} updated on board ${boardId}.`;
    },
    {
      name: "update_kanban_task",
      description: [
        "Update fields of the contact's existing kanban card on a board (title, priority, column, note, due date). Requires the card to already exist — use kanban_move_card first to create it. Provide boardId to identify which board's card to update.",
        hint ? `Operator guidance: ${hint}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: z.object({
        boardId: z.number().int().positive().describe("Board ID of the card to update."),
        title: z.string().optional().describe("New card title."),
        priority: z
          .enum(["none", "low", "medium", "high", "urgent"])
          .optional()
          .describe("New priority level."),
        columnId: z.number().int().positive().optional().describe("Move to this column ID."),
        note: z.string().optional().describe("Add a note to the card."),
        dueDate: z.string().optional().describe("Due date in YYYY-MM-DD format."),
      }),
    },
  );
}

const choiceSchema = z.object({
  displayText: z.string().min(1).describe("Label shown on the choice."),
  type: z.enum(["reply", "copy", "call", "url"]).describe(
    "reply = sends `id` back as the customer's message; copy = copies `copyText` to clipboard; call = dials `phoneNumber`; url = opens `url`.",
  ),
  id: z.string().optional().describe("Required for type=reply."),
  copyText: z.string().optional().describe("Required for type=copy."),
  phoneNumber: z.string().optional().describe("Required for type=call."),
  url: z.string().optional().describe("Required for type=url."),
});

function toDynamicChoice(c: z.infer<typeof choiceSchema>): WhazingDynamicChoice {
  switch (c.type) {
    case "reply":
      return { type: "reply", id: c.id ?? c.displayText, displayText: c.displayText };
    case "copy":
      return { type: "copy", copyText: c.copyText ?? "", displayText: c.displayText };
    case "call":
      return { type: "call", phoneNumber: c.phoneNumber ?? "", displayText: c.displayText };
    case "url":
      return { type: "url", url: c.url ?? "", displayText: c.displayText };
  }
}

function sendButtonMessageTool(ctx: WhazingToolCtx) {
  return tool(
    async ({
      text,
      buttons,
      headerImageUrl,
    }: {
      text: string;
      buttons: { id: string; title: string }[];
      headerImageUrl?: string;
    }) => {
      await ctx.client.sendButtonMessage(ctx.ticketId, text, buttons, { headerImageUrl });
      return "Button message sent.";
    },
    {
      name: "send_button_message",
      description:
        "Send an interactive WhatsApp message with up to 3 quick-reply buttons the customer can tap instead of typing (e.g. confirm/cancel, yes/no, pick a time slot).",
      schema: z.object({
        text: z.string().min(1).describe("Message body shown above the buttons."),
        buttons: z
          .array(
            z.object({
              id: z.string().min(1).describe("Echoed back as the customer's reply when tapped."),
              title: z.string().min(1).max(20).describe("Button label (short, ~20 chars max)."),
            }),
          )
          .min(1)
          .max(3)
          .describe("1 to 3 buttons."),
        headerImageUrl: z.string().url().optional().describe("Optional image shown above the text."),
      }),
    },
  );
}

function sendListMessageTool(ctx: WhazingToolCtx) {
  return tool(
    async ({
      headerText,
      bodyText,
      buttonText,
      sections,
    }: {
      headerText?: string;
      bodyText: string;
      buttonText: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
    }) => {
      await ctx.client.sendListMessage(ctx.ticketId, { headerText, bodyText, buttonText, sections });
      return "List message sent.";
    },
    {
      name: "send_list_message",
      description:
        "Send a WhatsApp list message: a button that opens a scrollable menu of grouped options. Use for more than 3 choices, or when each option needs a short description (product catalog, service menu, time slots).",
      schema: z.object({
        headerText: z.string().optional().describe("Optional small title above the body."),
        bodyText: z.string().min(1).describe("Main message text."),
        buttonText: z.string().min(1).describe("Label of the button that opens the list, e.g. 'Ver opções'."),
        sections: z
          .array(
            z.object({
              title: z.string().min(1).describe("Section heading inside the list."),
              rows: z
                .array(
                  z.object({
                    id: z.string().min(1).describe("Echoed back as the customer's reply when tapped."),
                    title: z.string().min(1),
                    description: z.string().optional(),
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
      }),
    },
  );
}

function sendCarouselMessageTool(ctx: WhazingToolCtx) {
  return tool(
    async ({
      text,
      items,
    }: {
      text: string;
      items: { text: string; imageUrl: string; choices: z.infer<typeof choiceSchema>[] }[];
    }) => {
      await ctx.client.sendCarouselMessage(
        ctx.ticketId,
        text,
        items.map((it) => ({
          text: it.text,
          image: it.imageUrl,
          choices: it.choices.map(toDynamicChoice),
        })),
      );
      return "Carousel sent.";
    },
    {
      name: "send_carousel_message",
      description:
        "Send a horizontally-scrollable carousel of cards (image + text + up to 3 choices each). Use to showcase multiple products/plans/options side by side.",
      schema: z.object({
        text: z.string().min(1).describe("Intro text shown above the carousel."),
        items: z
          .array(
            z.object({
              text: z.string().min(1).describe("Card text (title/description)."),
              imageUrl: z.string().url().describe("Public image URL for the card."),
              choices: z.array(choiceSchema).min(1).max(3),
            }),
          )
          .min(1)
          .max(10),
      }),
    },
  );
}

function sendPixButtonTool(ctx: WhazingToolCtx) {
  return tool(
    async () => {
      if (!ctx.pixConfig) {
        return "PIX is not configured for this agent. Use handoff_to_human instead of inventing payment details.";
      }
      await ctx.client.sendPixButtonMessage(ctx.ticketId, ctx.pixConfig);
      return "PIX key button sent.";
    },
    {
      name: "send_pix_button",
      description:
        "Send a 'copy PIX key' button with the business's configured PIX key, so the customer can pay by tapping to copy the key into their bank app. Takes no arguments — the key is fixed by the operator, never invented.",
      schema: z.object({}),
    },
  );
}

function requestPaymentTool(ctx: WhazingToolCtx) {
  return tool(
    async ({
      amount,
      text,
      title,
      footer,
      itemName,
    }: {
      amount: number;
      text?: string;
      title?: string;
      footer?: string;
      itemName?: string;
    }) => {
      if (!ctx.pixConfig) {
        return "PIX is not configured for this agent. Use handoff_to_human instead of inventing payment details.";
      }
      await ctx.client.sendPaymentRequestMessage(ctx.ticketId, {
        amount,
        text,
        title,
        footer,
        itemName,
        ...ctx.pixConfig,
      });
      return `Payment request for ${amount} sent.`;
    },
    {
      name: "request_payment",
      description:
        "Send a payment-request card for a specific amount, payable via the business's configured PIX key. Only the amount and surrounding copy are yours to fill in — the PIX key itself is fixed by the operator.",
      schema: z.object({
        amount: z.number().positive().describe("Amount to charge, in BRL (e.g. 199.90)."),
        text: z.string().optional().describe("Short message shown with the request, e.g. what it's for."),
        title: z.string().optional().describe("Card title, e.g. 'Detalhes do pedido'."),
        footer: z.string().optional(),
        itemName: z.string().optional().describe("Name of the item/service being charged for."),
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
  "kanban_move_card",
  "update_kanban_task",
  "send_button_message",
  "send_list_message",
  "send_carousel_message",
  "send_pix_button",
  "request_payment",
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
    kanbanMoveCardTool(ctx),
    updateKanbanTaskTool(ctx),
    sendButtonMessageTool(ctx),
    sendListMessageTool(ctx),
    sendCarouselMessageTool(ctx),
    sendPixButtonTool(ctx),
    requestPaymentTool(ctx),
  ];
  if (!allowed) return all;
  const allow = new Set(allowed);
  return all.filter((t) => allow.has(t.name));
}
