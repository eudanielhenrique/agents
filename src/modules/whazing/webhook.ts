import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { wasRecentlyBotSent } from "./bot-send-tracker";
import { loadWhazingClient, resolveInstanceByRouteToken } from "./instance";
import { resolveEscalateQueueId, runWhazingIntake } from "./intake";
import {
  isManualHumanReply,
  isNewIncomingMessage,
  normalizeWhazingEvent,
  shouldWhazingBotHandle,
  whazingDeliveryId,
} from "./normalize";
import { runWhazingAgentTurn } from "./runtime";
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
