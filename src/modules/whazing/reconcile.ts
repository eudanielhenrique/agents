import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { loadWhazingClient } from "./instance";

// Whazing only tells us a ticket closed via a "ticket_status_changed" webhook — if that webhook
// never fires (the platform is young; docs/whazing.md already flags "tentative API endpoints"),
// our mirror stays "pending"/"open" forever even though the real ticket closed, or a whole new
// ticket superseded it, days ago. One WHAZING_RECONCILE job per tenant, self-rearming every 24h,
// polls /showticket (by contact phone — the only lookup Whazing's API supports) for every
// non-resolved conversation and corrects drift.

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function whazingReconcileHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const ctx = sysCtx(tenantId);
  const pending = await runScopedOn(base, ctx, (db) =>
    db.whazingConversation.findMany({
      where: { status: { not: "resolved" }, contactPhone: { not: null } },
      select: {
        id: true,
        instanceId: true,
        ticketId: true,
        contactPhone: true,
      },
    }),
  );

  await mapWithConcurrency(pending, CONCURRENCY, async (conv) => {
    try {
      const client = await loadWhazingClient(tenantId, conv.instanceId, base);
      const current = await client.showTicketByPhone(
        conv.contactPhone as string,
      );
      // No ticket found for this phone at all, or the contact's current ticket is a different
      // (newer) one — either way, this row's ticket is over and not coming back.
      const status =
        !current || current.id !== conv.ticketId
          ? "resolved"
          : current.status === "closed"
            ? "resolved"
            : current.status;
      await runScopedOn(base, ctx, (db) =>
        db.whazingConversation.update({
          where: { id: conv.id },
          data: { status },
        }),
      );
    } catch (e) {
      // One contact's API error (network blip, deleted contact) never fails the whole sweep.
      logger.warn(
        { ticketId: conv.ticketId, error: e },
        "whazing reconcile: per-conversation check failed (non-fatal)",
      );
    }
  });

  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + RECONCILE_INTERVAL_MS),
  };
}

let registered = false;
export function registerWhazingReconcileHandler(): void {
  if (registered) return;
  registerJobHandler("WHAZING_RECONCILE", whazingReconcileHandler);
  registered = true;
}

export async function ensureWhazingReconcile(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "WHAZING_RECONCILE",
    dedupeKey: "whazing-reconcile",
    runAt: new Date(Date.now() + RECONCILE_INTERVAL_MS),
    base,
  });
}

// Arms the sweep only for tenants that actually have a Whazing instance — no point polling
// tenants that never connected Whazing.
export async function ensureAllWhazingReconciles(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const rows = await asSuperAdminOn(base, (db) =>
    db.whazingInstance.findMany({
      distinct: ["tenantId"],
      select: { tenantId: true },
    }),
  );
  for (const r of rows) await ensureWhazingReconcile(r.tenantId, base);
}
