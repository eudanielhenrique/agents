import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { wasRecentlyBotSent } from "./bot-send-tracker";
import { resolveWhazingInboxAndAgent } from "./inbox-resolve";
import { loadWhazingClient, resolveInstanceByRouteToken } from "./instance";
import { resolveEscalateQueueId, runWhazingIntake } from "./intake";
import {
  isManualHumanReply,
  isNewIncomingMessage,
  normalizeWhazingEvent,
  shouldWhazingBotHandle,
  whazingControlCommand,
  whazingDeliveryId,
} from "./normalize";
import { runWhazingAgentTurn, upsertWhazingConversation } from "./runtime";
import { resolveWhazingGraphThreadId } from "./thread-keys";
import type { NormalizedWhazingEvent } from "./types";

// Whazing channel webhook receiver.
// Auth: the route token is the only secret — verified by constant-time hash probe against
// WhazingInstance.webhookRouteTokenHash. No HMAC (Whazing does not sign payloads).
// Idempotency: WhazingWebhookDelivery keyed by (whazingInstanceId, deliveryId).
// The ledger does NOT store the payload (PII); the normalized event is passed in-memory.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

export interface ReceiveWhazingResult {
  ack: true;
  outcome: "queued" | "duplicate" | "ignored";
  tenantId?: bigint;
  instanceId?: bigint;
  deliveryRowId?: bigint;
  normalized?: NormalizedWhazingEvent;
}

export interface ReceiveWhazingParams {
  routeToken: string;
  rawBody: string;
  base?: PrismaClient;
}

export async function receiveWhazingWebhook(
  params: ReceiveWhazingParams,
): Promise<ReceiveWhazingResult> {
  const base = params.base ?? basePrisma;

  // Auth: constant-time hash probe — unknown token and disconnected instance collapse into the
  // same 401 so the response gives no oracle for which routes are live.
  const resolved = await resolveInstanceByRouteToken(params.routeToken, base);
  if (!resolved) throw new UnauthorizedError();

  const { tenantId, instanceId } = resolved;

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    throw new AppError("invalid JSON body", 400);
  }

  const normalized = normalizeWhazingEvent(parsed);
  // Unknown event type or malformed payload — ack without recording; nothing to process.
  if (!normalized) return { ack: true, outcome: "ignored" };

  // Delivery id: prefer the message id (stable across retries), fall back to body digest.
  const deliveryId = whazingDeliveryId(
    normalized.message?.id ?? null,
    params.rawBody,
  );

  const { rowId, duplicate } = await recordDelivery(
    base,
    tenantId,
    instanceId,
    deliveryId,
    normalized.event,
  );

  return {
    ack: true,
    outcome: duplicate ? "duplicate" : "queued",
    tenantId,
    instanceId,
    deliveryRowId: rowId,
    normalized,
  };
}

// Idempotency ledger insert: create-then-catch. Unique on (whazing_instance_id, delivery_id).
async function recordDelivery(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  deliveryId: string,
  event: string,
): Promise<{ rowId: bigint; duplicate: boolean }> {
  try {
    const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.whazingWebhookDelivery.create({
        data: {
          tenantId,
          instanceId,
          deliveryId,
          event,
          status: "PENDING",
        },
        select: { id: true },
      }),
    );
    return { rowId: row.id, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.whazingWebhookDelivery.findFirst({
        where: { instanceId, deliveryId },
        select: { id: true },
      }),
    );
    if (!existing) throw err;
    return { rowId: existing.id, duplicate: true };
  }
}

export interface ProcessWhazingParams {
  tenantId: bigint;
  instanceId: bigint;
  deliveryRowId: bigint;
  normalized: NormalizedWhazingEvent;
  base?: PrismaClient;
}

// Detached processor: runs outside the ack path (caller should not await this).
// CAS PENDING→PROCESSING then gate → run the agent turn → CAS PROCESSED.
// A crash between the two CAS operations strands the row in PROCESSING;
// a future reaper (PROCESSING→PENDING after a timeout) would re-attempt.
export async function processWhazingDelivery(
  params: ProcessWhazingParams,
): Promise<void> {
  const base = params.base ?? basePrisma;
  const { tenantId, instanceId, deliveryRowId, normalized } = params;

  // CAS PENDING→PROCESSING. A duplicate POST that found an existing PENDING row sees 0
  // updated rows here and exits silently — the original delivery owns the processing.
  const claimed = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingWebhookDelivery.updateMany({
      where: { id: deliveryRowId, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    }),
  );
  if (claimed.count === 0) return;

  try {
    // A human agent typing directly in Whazing. Record it and stop — this message itself is not
    // for the bot to act on, but every customer message that follows must see the takeover.
    // wasRecentlyBotSent guards this: sendType ("bot"/"smartreception") turned out to be an
    // unreliable signal in practice — Whazing doesn't always stamp it on the echo of our own
    // sends, which was self-silencing the bot right after its own first reply (see bug fix
    // 2026-08-18, ticket 11372: humanTakeoverAt got set ~14s after Lia's own message, no human
    // involved at all). A message we ourselves sent seconds ago is never a takeover.
    if (
      isManualHumanReply(normalized) &&
      normalized.ticketId != null &&
      !wasRecentlyBotSent(instanceId, normalized.ticketId)
    ) {
      const ticketId = normalized.ticketId;
      await recordHumanTakeover(base, tenantId, instanceId, ticketId);
      // Best-effort: also move the ticket in Whazing itself, not just our own gate. A configured
      // escalate queue is optional (humanTakeoverAt alone already stops the bot without it).
      try {
        const escalateQueueId = await resolveEscalateQueueId(
          base,
          tenantId,
          instanceId,
        );
        if (escalateQueueId != null) {
          const client = await loadWhazingClient(tenantId, instanceId, base);
          await client.assignTicketToQueue(ticketId, escalateQueueId);
        }
      } catch (e) {
        logger.warn(
          { ticketId, error: e },
          "whazing: queue move on human takeover failed (non-fatal)",
        );
      }
      await markProcessed(base, tenantId, deliveryRowId);
      return;
    }

    // Double-gate: skip events that carry no actionable customer message.
    if (
      !isNewIncomingMessage(normalized) ||
      !shouldWhazingBotHandle(normalized)
    ) {
      await markProcessed(base, tenantId, deliveryRowId);
      return;
    }

    // The live event (queueId/assignedUserId) can lag a human takeover — Whazing's own queue move
    // is driven by an external automation with its own round-trip. This local flag is the fast
    // path that closes that race.
    if (
      normalized.ticketId != null &&
      (await hasHumanTakenOver(base, tenantId, instanceId, normalized.ticketId))
    ) {
      await markProcessed(base, tenantId, deliveryRowId);
      return;
    }

    // Test-mode command/gate — a "test" agent stays silent on this ticket until /teste, mirroring
    // Chatwoot's maybeConsumeCommandOrGate. Runs BEFORE intake on purpose: a not-yet-activated test
    // agent must not tag campaign leads or route production traffic while still silenced.
    if (
      await maybeConsumeWhazingCommandOrGate({
        tenantId,
        instanceId,
        normalized,
        base,
      })
    ) {
      await markProcessed(base, tenantId, deliveryRowId);
      return;
    }

    // Intake routing + campaign tagging run once, on the first message we ever see for a ticket
    // (no WhazingConversation row yet) — every message after that is either already on the right
    // queue or already covered by the takeover check above. The queue move this makes only takes
    // effect on the NEXT webhook — this event's own queueId is stale until then — so THIS turn is
    // routed from the return value, not from re-reading normalized.queueId.
    if (
      normalized.status === "pending" &&
      normalized.ticketId != null &&
      !(await isKnownTicket(base, tenantId, instanceId, normalized.ticketId))
    ) {
      const routing = await runWhazingIntake({
        tenantId,
        instanceId,
        event: normalized,
        base,
      });
      if (routing.routedTo === "escalate" || routing.routedTo === "skipped") {
        // "escalate": contact has prior history or was already answered — not the bot's ticket.
        // "skipped": the check itself failed — fail closed rather than answer on an unknown state.
        // Either way, no WhazingConversation row exists yet, so the next message retries this.
        await markProcessed(base, tenantId, deliveryRowId);
        return;
      }
      if (routing.botQueueId != null) {
        normalized.queueId = routing.botQueueId;
      }
    }

    const outcome = await runWhazingAgentTurn({
      tenantId,
      instanceId,
      event: normalized,
      base,
    });
    logger.info(
      "whazing agent turn: tenant=%s instance=%s ticket=%s outcome=%s",
      String(tenantId),
      String(instanceId),
      String(normalized.ticketId),
      outcome,
    );

    await markProcessed(base, tenantId, deliveryRowId);
  } catch (err) {
    logger.error(
      "processWhazingDelivery error: tenant=%s delivery=%s: %s",
      String(tenantId),
      String(deliveryRowId),
      err instanceof Error ? err.message : String(err),
    );
    // Leave in PROCESSING — reaper will reset to PENDING for retry.
  }
}

// Test-mode command/gate — the Whazing counterpart of chatwoot/webhook.ts's
// maybeConsumeCommandOrGate, scoped to the safety-critical part only: /teste activates the
// conversation, /reset (once activated) clears the graph memory, and a "test" mode agent stays
// silent (one-shot private note) until activated. Returns true when the delivery was fully handled
// here (the caller must not run the normal turn).
async function maybeConsumeWhazingCommandOrGate(params: {
  tenantId: bigint;
  instanceId: bigint;
  normalized: NormalizedWhazingEvent;
  base: PrismaClient;
}): Promise<boolean> {
  const { tenantId, instanceId, normalized, base } = params;
  const ticketId = normalized.ticketId;
  if (ticketId == null) return false;

  const command = whazingControlCommand(normalized.message?.body);

  const inbox = await resolveWhazingInboxAndAgent(
    base,
    tenantId,
    instanceId,
    normalized.queueId,
  );
  if (!inbox) return false;
  const agentId = inbox.agentId;

  const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agent.findUnique({ where: { id: agentId }, select: { mode: true } }),
  );
  if (!agent) return false;
  // Hot-path skip: the overwhelming majority of traffic is a production-mode agent with no control
  // command — nothing below applies, so avoid the extra mirror upsert + read on every message. A
  // production agent that later gets switched to "test" starts silenced from its next message on
  // (no row means "not activated"), which is the safe direction to be wrong in.
  if (agent.mode !== "test" && command === null) return false;
  // Control commands only apply to a test-mode agent (mirrors Chatwoot's commandActive) — on a
  // production agent, "/teste"/"/reset" are just ordinary text, answered normally.
  const commandActive = command !== null && agent.mode === "test";

  const client = await loadWhazingClient(tenantId, instanceId, base);
  const threadId = resolveWhazingGraphThreadId(tenantId, instanceId, {
    whatsappId: normalized.contact?.whatsappId ?? undefined,
    contactId: normalized.contact?.id ?? undefined,
    ticketId,
  });

  // Mirror the ticket unconditionally BEFORE reading test-mode state (same reasoning as Chatwoot's
  // mirrorChatwootEvent running before its gate) — guarantees a row exists so the notice/activation
  // watermarks below always persist, even on a brand-new ticket's very first message. Never touches
  // testActivatedAt/testNoticeSentAt itself, so it cannot clobber existing test-mode state.
  await upsertWhazingConversation(base, sysCtx(tenantId), {
    instanceId,
    inboxId: inbox.inboxId,
    ticketId,
    threadId,
    agentId,
    status: normalized.status,
    assignedUserId: normalized.assignedUserId,
    contactId: normalized.contact?.id ?? null,
    contactName: normalized.contact?.name ?? null,
    contactPhone: normalized.contact?.phone ?? null,
  });

  const existing = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findUnique({
      where: {
        tenantId_instanceId_ticketId: { tenantId, instanceId, ticketId },
      },
      select: { testActivatedAt: true, testNoticeSentAt: true },
    }),
  );
  const testActivatedAt = existing?.testActivatedAt ?? null;
  const testNoticeSentAt = existing?.testNoticeSentAt ?? null;

  const ack = async (text: string): Promise<void> => {
    try {
      await client.sendMessage(ticketId, text);
    } catch (e) {
      logger.warn(
        { ticketId, error: e },
        "whazing: command ack failed (non-fatal)",
      );
    }
  };

  if (commandActive && command === "teste") {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.whazingConversation.updateMany({
        where: { tenantId, instanceId, ticketId },
        data: { testActivatedAt: new Date(), lastInboundAt: null },
      }),
    );
    await ack("🧪 Modo teste ativado para esta conversa.");
    logger.info("whazing: /teste activated (ticket=%s)", String(ticketId));
    return true;
  }

  if (commandActive && command === "reset" && testActivatedAt != null) {
    try {
      const cp = await getCheckpointer();
      await cp.deleteThread(threadId);
    } catch (e) {
      logger.warn(
        { ticketId, error: e },
        "whazing: /reset memory clear failed (non-fatal)",
      );
    }
    await ack("🔄 Memória desta conversa foi limpa.");
    logger.info("whazing: /reset (ticket=%s)", String(ticketId));
    return true;
  }
  // /reset before activation: fall through to the gate below — must NOT answer pre-activation
  // (mirrors the Chatwoot bug fix documented in chatwoot/webhook.ts around isReset).

  if (agent.mode === "test" && testActivatedAt === null) {
    if (testNoticeSentAt === null) {
      try {
        await client.sendPrivateNote(
          ticketId,
          "🧪 Este agente está em modo teste. Ele não responde automaticamente nesta conversa. Envie /teste para ativar as respostas aqui.",
        );
      } catch (e) {
        logger.warn(
          { ticketId, error: e },
          "whazing: test-mode notice failed (non-fatal)",
        );
      }
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.whazingConversation.updateMany({
          where: { tenantId, instanceId, ticketId },
          data: { testNoticeSentAt: new Date() },
        }),
      );
    }
    return true;
  }

  return false;
}

// Whether we already have a WhazingConversation row for this ticket — the intake-routing gate: a
// ticket only gets routed once, on its first message (see processWhazingDelivery).
async function isKnownTicket(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  ticketId: number,
): Promise<boolean> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findUnique({
      where: {
        tenantId_instanceId_ticketId: { tenantId, instanceId, ticketId },
      },
      select: { id: true },
    }),
  );
  return row != null;
}

// A human just typed directly in Whazing. Whazing's own queue move away from the bot's queue is
// driven by an external automation (n8n) — this local flag is the synchronous signal, checked
// before the very next customer message reaches the bot, so we don't depend on that round-trip
// landing in time.
async function recordHumanTakeover(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  ticketId: number,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.updateMany({
      where: { tenantId, instanceId, ticketId },
      data: { humanTakeoverAt: new Date() },
    }),
  );
}

async function hasHumanTakenOver(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  ticketId: number,
): Promise<boolean> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findUnique({
      where: {
        tenantId_instanceId_ticketId: { tenantId, instanceId, ticketId },
      },
      select: { humanTakeoverAt: true },
    }),
  );
  return row?.humanTakeoverAt != null;
}

async function markProcessed(
  base: PrismaClient,
  tenantId: bigint,
  deliveryRowId: bigint,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingWebhookDelivery.update({
      where: { id: deliveryRowId },
      data: { status: "PROCESSED", processedAt: new Date() },
    }),
  );
}
