import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { runWhazingAgentTurn } from "./runtime";
import {
  isNewIncomingMessage,
  normalizeWhazingEvent,
  shouldWhazingBotHandle,
  whazingDeliveryId,
} from "./normalize";
import { resolveInstanceByRouteToken } from "./instance";
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
          whazingInstanceId: instanceId,
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
        where: { whazingInstanceId: instanceId, deliveryId },
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
    // Double-gate: skip events that carry no actionable customer message.
    if (!isNewIncomingMessage(normalized) || !shouldWhazingBotHandle(normalized)) {
      await markProcessed(base, tenantId, deliveryRowId);
      return;
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
