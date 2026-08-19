import { HumanMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { lastAssistantText } from "@/graph/graph";
import {
  type AgentNudge,
  isNudgeSilent,
  OUTSIDE_WINDOW_NOTE_PREFIX,
  type RunAgentNudgeOutcome,
  renderNudge,
} from "@/graph/nudge";
import {
  buildCallbacks,
  buildModelAndGraph,
  buildToolset,
  loadAgentConfig,
  type ToolBuildDeps,
} from "@/graph/prepare";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  isWithinServiceWindow,
  type ServiceWindowConfig,
} from "@/modules/service-window/service";
import { markBotSent } from "@/modules/whazing/bot-send-tracker";
import { loadWhazingClient } from "./instance";
import { buildWhazingNativeTools } from "./tools";

// Whazing's proactive-nudge engine. Parallel to runAgentNudge (src/graph/nudge.ts) but transport-aware
// — same reasoning as runtime.ts vs whazing/runtime.ts. Reuses every already-agnostic piece (AgentNudge,
// renderNudge, isNudgeSilent, loadAgentConfig, buildToolset, buildModelAndGraph, buildCallbacks); the
// Chatwoot-only parts (conversation lookup by chatwootInstanceId/chatwootConversationId, ChatwootClient,
// sendMessage/sendTemplate/sendPrivateNote/toggleStatus) are replaced with the Whazing equivalents.
//
// Unlike Chatwoot, a Whazing threadId has no single decodable shape (see thread-keys.ts — ticket-based,
// contact-channel-based, or phone-based, depending on what was known when the thread was first
// resolved). Rather than parsing it, WhazingConversation already stores the resolved threadId as a
// plain column, so this looks the row up directly instead of decomposing the string.
//
// Service-window: Whazing DOES enforce WhatsApp's 24h window (confirmed operationally), but
// WhazingClient has no template-send capability yet (no Whazing API endpoint confirmed for it). So
// "outside the window" here never attempts a template — it always falls back to a private note,
// same pt-BR explanation Chatwoot uses, so the operator sees why nothing went to the customer instead
// of the message silently vanishing.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Pure decision: never "template" (WhazingClient can't send one yet) — collapses straight to "note"
// whenever the window gate would otherwise call for a template on the Chatwoot side.
export function decideWhazingNudgeDelivery(
  cfg: ServiceWindowConfig,
  lastInboundAt: Date | null,
  now: Date,
): "freeform" | "note" {
  if (!cfg.enabled) return "freeform";
  return isWithinServiceWindow(lastInboundAt, now, cfg.windowHours)
    ? "freeform"
    : "note";
}

export interface RunWhazingAgentNudgeParams {
  tenantId: bigint;
  threadId: string;
  nudge: AgentNudge;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

export async function runWhazingAgentNudge(
  params: RunWhazingAgentNudgeParams,
): Promise<RunAgentNudgeOutcome> {
  const { tenantId, threadId, nudge } = params;
  const base = params.base ?? basePrisma;

  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findFirst({
      where: { tenantId, threadId },
      select: {
        id: true,
        instanceId: true,
        ticketId: true,
        agentId: true,
        contactId: true,
        lastInboundAt: true,
        humanTakeoverAt: true,
        assignedUserId: true,
      },
    }),
  );
  if (!conv?.agentId) return "no-agent";
  const { instanceId, ticketId, agentId } = conv;

  const canMessageCustomer =
    conv.humanTakeoverAt == null && conv.assignedUserId == null;
  if (!canMessageCustomer) return "stale";

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

  const client = await loadWhazingClient(tenantId, instanceId, base);

  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: conv.id,
    agentId,
    inboxId: null,
    threadId,
    base,
  };

  const whazingNativeTools: ToolBuildDeps["buildNativeTools"] = (
    nativeCtx,
    allowed,
  ) =>
    buildWhazingNativeTools(
      {
        client,
        instanceId,
        ticketId,
        contactId: conv.contactId ?? undefined,
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

  const checkpointer = params.deps?.checkpointer ?? (await getCheckpointer());
  const graph = await buildModelAndGraph(loaded, tools, { checkpointer });
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    turnId: flow.turnId,
    tools,
  });

  const result = await graph.invoke(
    { messages: [new HumanMessage(renderNudge(nudge, canMessageCustomer))] },
    { configurable: { thread_id: threadId }, callbacks },
  );
  const reply = lastAssistantText(result.messages).trim();
  if (isNudgeSilent(reply)) return "silent";

  // Re-check: the model may have taken a while — a human could have taken over mid-invoke.
  const recheck = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findUnique({
      where: { id: conv.id },
      select: { humanTakeoverAt: true, assignedUserId: true },
    }),
  );
  if (
    recheck &&
    (recheck.humanTakeoverAt != null || recheck.assignedUserId != null)
  ) {
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "ok",
      detail: { outcome: "taken_over" },
    });
    return "stale";
  }

  const mode = decideWhazingNudgeDelivery(
    loaded.serviceWindowConfig,
    conv.lastInboundAt,
    new Date(),
  );

  if (mode === "freeform") {
    await client.sendMessage(ticketId, reply);
    markBotSent(instanceId, ticketId);
    return "messaged";
  }

  // Outside the window: WhazingClient has no template-send capability yet — always a private note
  // instead of a customer message, never a silent drop.
  await client.sendPrivateNote(
    ticketId,
    `${OUTSIDE_WINDOW_NOTE_PREFIX}${reply}`,
  );
  return "noted-window";
}
