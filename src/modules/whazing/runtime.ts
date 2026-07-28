import { HumanMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { deliverReply } from "@/modules/split/service";
import { getCheckpointer } from "@/graph/checkpointer";
import { lastAssistantText } from "@/graph/graph";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import {
  buildCallbacks,
  buildModelAndGraph,
  buildToolset,
  loadAgentConfig,
  type ToolBuildDeps,
} from "@/graph/prepare";
import type { RunAgentTurnOutcome } from "@/graph/runtime";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { resolveWhazingGraphThreadId } from "./thread-keys";
import { loadWhazingClient } from "./instance";
import type { NormalizedWhazingEvent } from "./types";

// Whazing agent runtime. Parallel to runAgentTurn in src/graph/runtime.ts but transport-aware:
// uses WhazingClient instead of ChatwootClient, resolves the inbox via WhazingInbox (not
// Chatwoot Inbox), and skips native Chatwoot tools (TODO: replace with Whazing-native tools
// in issue #8: handoff/close/tags).
//
// loadAgentConfig is still called with instanceId=0 and conversationId=ticketId. The chatwoot
// conv query returns null (no such row), so contact/inbox prompt vars are empty for now — a
// known MVP limitation documented as TODO.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface RunWhazingAgentTurnParams {
  tenantId: bigint;
  instanceId: bigint;
  event: NormalizedWhazingEvent;
  base?: PrismaClient;
}

export async function runWhazingAgentTurn(
  params: RunWhazingAgentTurnParams,
): Promise<RunAgentTurnOutcome> {
  const { tenantId, instanceId, event } = params;
  const base = params.base ?? basePrisma;

  const ticketId = event.ticketId;
  if (ticketId == null) return "skipped";

  // Resolve the WhazingInbox that handles this ticket's queue.
  // Priority: matching queueId → catch-all (null queueId).
  const inbox = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    if (event.queueId != null) {
      const specific = await db.whazingInbox.findFirst({
        where: { tenantId, instanceId, whazingQueueId: String(event.queueId) },
        select: { agentId: true },
      });
      if (specific) return specific;
    }
    return db.whazingInbox.findFirst({
      where: { tenantId, instanceId, whazingQueueId: null },
      select: { agentId: true },
    });
  });

  if (!inbox?.agentId) return "no-agent";
  const agentId = inbox.agentId;

  const threadId = resolveWhazingGraphThreadId(
    tenantId,
    instanceId,
    {
      whatsappId: event.contact?.whatsappId ?? undefined,
      contactId: event.contact?.id != null ? String(event.contact.id) : undefined,
      ticketId,
    },
  );

  // Load agent config. instanceId=0 prevents accidental matches in Chatwoot tables;
  // conversationId=ticketId is a no-match placeholder — conv will be null.
  // TODO: add a dedicated WhazingConversation row for proper contact/inbox prompt vars.
  const loaded = await runScopedOn(base, sysCtx(tenantId), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId: BigInt(0),
      conversationId: ticketId,
      agentId,
      threadId,
    }),
  );
  if (!loaded) return "no-agent";

  // Build message text from the event.
  const text = event.message?.body?.trim() ?? "";
  if (!text) return "skipped";

  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: null,
    agentId,
    inboxId: null,
    threadId,
    base,
  };

  const client = await loadWhazingClient(tenantId, instanceId, base);

  // buildToolset with no native tools (Whazing-native tools: TODO #8).
  // The cast is safe: ctx.client is used inside buildToolset only for slow-tool acks
  // (sendMessage + toggleTyping — both in InboxReplyClient), and buildNativeTools is
  // a no-op stub that ignores its client argument entirely.
  const noNativeTools: ToolBuildDeps["buildNativeTools"] = () =>
    [] as StructuredToolInterface[];
  const tools = await buildToolset(
    loaded,
    {
      tenantId,
      instanceId,
      base,
      client: client as unknown as ChatwootClient,
      conversationId: ticketId,
      threadId,
    },
    { buildNativeTools: noNativeTools, flow },
  );

  const checkpointer = await getCheckpointer();
  const graph = await buildModelAndGraph(loaded, tools, {
    checkpointer,
    onToolLimit: ({ maxToolCalls, toolCalls }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: maxToolCalls, toolCalls },
      }),
  });
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    turnId: flow.turnId,
    tools,
  });

  markTurnInFlight(threadId);
  try {
    const result = await graph.invoke(
      { messages: [new HumanMessage(text)] },
      { configurable: { thread_id: threadId }, callbacks },
    );
    const reply = lastAssistantText(result.messages).trim();
    if (!reply) return "empty";

    // Re-check: did a human take over while the LLM was thinking?
    const ticket = await client.getTicket(ticketId).catch(() => null);
    if (ticket) {
      const t = ticket as Record<string, unknown>;
      const takenOver = t.assignedUserId != null || t.status === "closed";
      if (takenOver) {
        emitFlowEvent(flow, {
          stage: "handoff",
          status: "ok",
          detail: { outcome: "taken_over" },
        });
        return "taken-over";
      }
    }

    await deliverReply(client, ticketId, reply, loaded.splitConfig, undefined, flow);
    logger.info(
      "whazing agent replied: ticket=%s thread=%s len=%d",
      String(ticketId),
      threadId,
      reply.length,
    );
    return "posted";
  } finally {
    clearTurnInFlight(threadId);
  }
}
