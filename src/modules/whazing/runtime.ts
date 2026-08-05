import { HumanMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
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
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { deliverReply } from "@/modules/split/service";
import { looksLikePersonName } from "@/modules/whazing/contact-name";
import { loadWhazingClient } from "./instance";
import { resolveWhazingSttConfig, transcribeWhazingAudio } from "./media";
import { renderWhazingMessage } from "./render";
import { resolveWhazingGraphThreadId } from "./thread-keys";
import { buildWhazingNativeTools } from "./tools";
import type { NormalizedWhazingEvent } from "./types";

// Upsert the WhazingConversation mirror row so the Conversations page can show Whazing tickets.
// Returns the row id (used as conversationId in ExecutionLog for trail markers).
async function upsertWhazingConversation(
  base: PrismaClient,
  ctx: TenantContext,
  params: {
    instanceId: bigint;
    inboxId: bigint | null;
    ticketId: number;
    threadId: string;
    agentId: bigint;
    status: string | null;
    assignedUserId: number | null;
    contactId: number | null;
    contactName: string | null;
  },
): Promise<bigint> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const now = new Date();
  const status =
    params.status === "closed" ? "resolved" : (params.status ?? "open");
  const row = await runScopedOn(base, ctx, (db) =>
    db.whazingConversation.upsert({
      where: {
        tenantId_instanceId_ticketId: {
          tenantId,
          instanceId: params.instanceId,
          ticketId: params.ticketId,
        },
      },
      create: {
        tenantId,
        instanceId: params.instanceId,
        inboxId: params.inboxId,
        ticketId: params.ticketId,
        threadId: params.threadId,
        status,
        assignedUserId: params.assignedUserId,
        contactId: params.contactId,
        contactName: params.contactName,
        agentId: params.agentId,
        lastEventAt: now,
        lastInboundAt: now,
      },
      update: {
        status,
        assignedUserId: params.assignedUserId,
        contactId: params.contactId ?? undefined,
        contactName: params.contactName ?? undefined,
        agentId: params.agentId,
        lastEventAt: now,
        lastInboundAt: now,
        lastError: null,
        lastErrorAt: null,
      },
      select: { id: true },
    }),
  );
  return row.id as bigint;
}

// Whazing agent runtime. Parallel to runAgentTurn in src/graph/runtime.ts but transport-aware:
// uses WhazingClient instead of ChatwootClient, resolves the inbox via WhazingInbox (not
// Chatwoot Inbox), and injects Whazing-native tools (handoff/close/note — see tools.ts).
//
// loadAgentConfig is still called with instanceId=0 and conversationId=ticketId (the chatwoot
// conv query returns null — no such row), so most contact/inbox prompt vars stay empty. The one
// exception is {{nome_contato}}: injected below via a promptVars override from the real WhatsApp
// profile name, when it looks like an actual person's name (see contact-name.ts).

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
        select: { id: true, agentId: true },
      });
      if (specific) return specific;
    }
    return db.whazingInbox.findFirst({
      where: { tenantId, instanceId, whazingQueueId: null },
      select: { id: true, agentId: true },
    });
  });

  if (!inbox?.agentId) return "no-agent";
  const agentId = inbox.agentId;

  const threadId = resolveWhazingGraphThreadId(tenantId, instanceId, {
    whatsappId: event.contact?.whatsappId ?? undefined,
    contactId: event.contact?.id ?? undefined,
    ticketId,
  });

  // Load agent config. instanceId=0 prevents accidental matches in Chatwoot tables;
  // conversationId=ticketId is a no-match placeholder — conv will be null, so contact/inbox prompt
  // vars would normally resolve empty (see loadAgentConfig). We DO have the real WhatsApp profile
  // name from the webhook event, so inject it as a promptVars override (the same mechanism the
  // playground uses to simulate {{nome_contato}}) — but only when it looks like an actual person's
  // name, not a WhatsApp handle/emoji (see contact-name.ts). A messy/absent name is left unset so
  // the agent's own prompt instructions decide whether to ask for it.
  const rawContactName = event.contact?.name ?? null;
  const promptVars = looksLikePersonName(rawContactName)
    ? { nome_contato: rawContactName as string }
    : undefined;
  const loaded = await runScopedOn(base, sysCtx(tenantId), (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId: BigInt(0),
        conversationId: ticketId,
        agentId,
        threadId,
      },
      { overrides: promptVars ? { promptVars } : undefined },
    ),
  );
  if (!loaded) return "no-agent";

  // Upsert the conversation mirror so the Conversations page shows this ticket.
  // Done before the flow context so the trail markers get the right conversationId.
  const whazingConvId = await upsertWhazingConversation(
    base,
    sysCtx(tenantId),
    {
      instanceId,
      inboxId: inbox.id ?? null,
      ticketId,
      threadId,
      agentId,
      status: event.status,
      assignedUserId: event.assignedUserId,
      contactId: event.contact?.id ?? null,
      contactName: event.contact?.name ?? null,
    },
  ).catch((e) => {
    logger.warn(
      "whazing conv upsert failed (non-fatal): %s",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  });
  // loadAgentConfig only ever looks up the Chatwoot Conversation table, so conversationDbId came
  // back null above. Point it at the Whazing mirror row now so LlmUsage/Langfuse attribute this
  // turn to a real conversation instead of dropping it (the dashboard's "conversations" figures
  // count DISTINCT LlmUsage.conversationId, so a null here means Whazing turns never show up).
  if (whazingConvId != null) loaded.conversationDbId = whazingConvId;

  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: whazingConvId,
    agentId,
    inboxId: null,
    threadId,
    base,
  };

  const client = await loadWhazingClient(tenantId, instanceId, base);

  // Attempt STT for the first audio attachment (best-effort — never strands the delivery).
  let transcription: string | null = null;
  const sttCfg = await resolveWhazingSttConfig(tenantId, agentId, base);
  if (sttCfg) {
    const audioAtt = event.message?.attachments.find(
      (a) =>
        a.mediaUrl &&
        (a.mediaType === "audio" ||
          a.mediaType === "voice" ||
          a.mediaType === "ptt"),
    );
    if (audioAtt?.mediaUrl) {
      transcription = await transcribeWhazingAudio({
        mediaUrl: audioAtt.mediaUrl,
        cfg: sttCfg,
        tenantId,
        base,
        flow,
      }).catch((e) => {
        logger.warn(
          "whazing stt unexpected error (ticket=%s): %s",
          String(ticketId),
          e instanceof Error ? e.message : String(e),
        );
        return null;
      });
    }
  }

  const text = renderWhazingMessage(event, transcription);
  if (!text) return "skipped";

  // buildToolset with Whazing-native tools. The ctx.client cast is safe: buildToolset
  // uses it only for slow-tool acks (sendMessage + toggleTyping — both in InboxReplyClient).
  // buildNativeTools ignores ctx.client entirely; instead, it closes over the actual
  // WhazingClient and ticketId via the outer closure.
  const whazingNativeTools: ToolBuildDeps["buildNativeTools"] = (
    nativeCtx,
    allowed,
  ) =>
    buildWhazingNativeTools(
      {
        client,
        ticketId,
        contactId: event.contact?.id ?? undefined,
        timezone: loaded.timezone,
        toolInstructions: nativeCtx.toolInstructions,
        pixConfig: loaded.pixConfig,
      },
      allowed,
    );
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
    { buildNativeTools: whazingNativeTools, flow },
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

    await deliverReply(
      client,
      ticketId,
      reply,
      loaded.splitConfig,
      undefined,
      flow,
    );
    logger.info(
      "whazing agent replied: ticket=%s thread=%s len=%d",
      String(ticketId),
      threadId,
      reply.length,
    );
    return "posted";
  } catch (err) {
    // Write the error to the conversation mirror so the operator sees it in the Conversations page.
    if (whazingConvId) {
      const msg = err instanceof Error ? err.message : String(err);
      runScopedOn(base, sysCtx(tenantId), (db) =>
        db.whazingConversation.update({
          where: { id: whazingConvId },
          data: { lastError: msg.slice(0, 500), lastErrorAt: new Date() },
        }),
      ).catch(() => {});
    }
    throw err;
  } finally {
    clearTurnInFlight(threadId);
  }
}
