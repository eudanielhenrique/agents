import { HumanMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { lastAssistantText } from "@/graph/graph";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import {
  type AgentConfig,
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
import { markBotSent } from "@/modules/whazing/bot-send-tracker";
import { looksLikePersonName } from "@/modules/whazing/contact-name";
import type { WhazingClient } from "./client";
import { armWhazingDebounce, resolveWhazingDebounceConfig } from "./debounce";
import { resolveWhazingInboxAndAgent } from "./inbox-resolve";
import { loadWhazingClient } from "./instance";
import { resolveWhazingSttConfig, transcribeWhazingAudio } from "./media";
import { renderWhazingMessage } from "./render";
import { resolveWhazingGraphThreadId } from "./thread-keys";
import { buildWhazingNativeTools } from "./tools";
import type { NormalizedWhazingEvent } from "./types";

// Upsert the WhazingConversation mirror row so the Conversations page can show Whazing tickets.
// Returns the row id (used as conversationId in ExecutionLog for trail markers). Exported: the
// test-mode command/gate (webhook.ts) also needs to upsert a row when /teste arrives on a
// not-yet-mirrored ticket.
export async function upsertWhazingConversation(
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
    contactPhone: string | null;
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
        contactPhone: params.contactPhone,
        agentId: params.agentId,
        lastEventAt: now,
        lastInboundAt: now,
      },
      update: {
        status,
        assignedUserId: params.assignedUserId,
        contactId: params.contactId ?? undefined,
        contactName: params.contactName ?? undefined,
        contactPhone: params.contactPhone ?? undefined,
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

  const inbox = await resolveWhazingInboxAndAgent(
    base,
    tenantId,
    instanceId,
    event.queueId ?? null,
  );
  if (!inbox) return "no-agent";
  const agentId = inbox.agentId;

  const threadId = resolveWhazingGraphThreadId(tenantId, instanceId, {
    whatsappId: event.contact?.whatsappId ?? undefined,
    contactId: event.contact?.id ?? undefined,
    ticketId,
  });

  // Two WhatsApp messages sent moments apart that both skip the debounce arm (e.g. debounce
  // disabled, or an image + its caption as separate webhook events before either renders text) each
  // spawn their own independent turn. Racing them produces two near-simultaneous LLM calls unaware
  // of each other, which can generate near-identical or duplicate replies. Wait for the in-flight
  // turn on this thread to clear so the second turn's history already includes the first turn's
  // reply — the model then naturally avoids repeating itself. Capped so a stuck/crashed turn never
  // strands a customer's message forever.
  const inFlightWaitStartedAt = Date.now();
  while (
    isTurnInFlight(threadId) &&
    Date.now() - inFlightWaitStartedAt < 30_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Mark IMMEDIATELY (zero `await` between the check above and this call) — marking only right
  // before graph.invoke left a wide gap (loadAgentConfig, the conv upsert, STT, buildToolset all
  // await) where a second delivery's wait-loop could pass its own check before the first delivery
  // ever marked, defeating the guard for two messages arriving close together. Every early return
  // between here and the graph.invoke try/finally below must clear this explicitly.
  markTurnInFlight(threadId);

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
  if (!loaded) {
    clearTurnInFlight(threadId);
    return "no-agent";
  }

  // Upsert the conversation mirror so the Conversations page shows this ticket.
  // Done before the flow context so the trail markers get the right conversationId.
  const whazingConvId = await upsertWhazingConversation(
    base,
    sysCtx(tenantId),
    {
      instanceId,
      inboxId: inbox.inboxId,
      ticketId,
      threadId,
      agentId,
      status: event.status,
      assignedUserId: event.assignedUserId,
      contactId: event.contact?.id ?? null,
      contactName: event.contact?.name ?? null,
      contactPhone: event.contact?.phone ?? null,
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

  let text = renderWhazingMessage(event, transcription);
  if (!text) {
    clearTurnInFlight(threadId);
    return "skipped";
  }

  // Surface already-collected intake/anamnesis data (contact.extraInfo, written by
  // save_anamnesis_data) so the model sees what it already knows and does not re-ask — this is
  // the concrete fix for "the agent keeps repeating questions it already got answers to".
  // Best-effort: a failed fetch just means this turn runs without the reminder, never blocks it.
  if (event.contact?.id != null) {
    const contact = await client.getContact(event.contact.id).catch(() => null);
    if (contact && contact.extraInfo.length > 0) {
      const known = contact.extraInfo
        .map((f) => `${f.name}: ${f.value}`)
        .join("; ");
      text = `[Dados já coletados sobre este paciente — NÃO pergunte de novo: ${known}]\n\n${text}`;
    }
  }

  // Debounce path: an incoming message on a debounce-enabled agent buffers its rendered text into
  // the durable WHAZING_DEBOUNCE job instead of answering right away — the fast worker flushes it
  // (coalesce + one reply). Arming is best-effort: any failure falls back to the direct turn below
  // so the customer is never left unanswered (same principle as the Chatwoot arm in webhook.ts).
  try {
    const cfg = await resolveWhazingDebounceConfig(tenantId, agentId, base);
    if (cfg) {
      await armWhazingDebounce({
        tenantId,
        threadId,
        ticketId,
        instanceId,
        queueId: event.queueId ?? null,
        text,
        contactId: event.contact?.id ?? null,
        rawContactName,
        cfg,
        base,
      });
      logger.info(
        "whazing: debounced (ticket=%s window=%ds)",
        String(ticketId),
        cfg.windowSeconds,
      );
      clearTurnInFlight(threadId);
      return "queued";
    }
  } catch (e) {
    logger.warn(
      "whazing debounce arm failed (ticket=%s), falling back to direct turn: %s",
      String(ticketId),
      e instanceof Error ? e.message : String(e),
    );
  }

  return runWhazingTurnTail({
    tenantId,
    instanceId,
    ticketId,
    threadId,
    loaded,
    text,
    client,
    contactId: event.contact?.id ?? undefined,
    whazingConvId,
    flow,
    base,
  });
}

export interface RunWhazingTurnTailParams {
  tenantId: bigint;
  instanceId: bigint;
  ticketId: number;
  threadId: string;
  loaded: AgentConfig;
  text: string;
  client: WhazingClient;
  contactId?: number;
  whazingConvId: bigint | null;
  flow: FlowContext;
  base: PrismaClient;
}

// The shared "tools ready → invoke → recheck takeover → deliver → mark sent" tail, reused by the
// direct path above AND the debounce flush (debounce.ts). Caller must call markTurnInFlight(threadId)
// before invoking this — the finally below is the single place that clears it.
export async function runWhazingTurnTail(
  params: RunWhazingTurnTailParams,
): Promise<RunAgentTurnOutcome> {
  const {
    tenantId,
    instanceId,
    ticketId,
    threadId,
    loaded,
    text,
    client,
    contactId,
    whazingConvId,
    flow,
    base,
  } = params;

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
        instanceId,
        ticketId,
        contactId,
        timezone: loaded.timezone,
        toolInstructions: nativeCtx.toolInstructions,
        pixConfig: loaded.pixConfig,
        handoffQueueId: loaded.handoffConfig.whazingQueueId,
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
    markBotSent(instanceId, ticketId);
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
