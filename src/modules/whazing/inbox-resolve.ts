import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface ResolvedWhazingInbox {
  inboxId: bigint;
  agentId: bigint;
}

// Resolves the WhazingInbox that handles a given queue. Priority: matching queueId → catch-all
// (whazingQueueId: null). Shared by the direct turn (runtime.ts), the debounce flush (debounce.ts),
// and the test-mode command/gate (webhook.ts) — previously duplicated in the first two.
export async function resolveWhazingInboxAndAgent(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  queueId: number | null,
): Promise<ResolvedWhazingInbox | null> {
  const inbox = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    if (queueId != null) {
      const specific = await db.whazingInbox.findFirst({
        where: { tenantId, instanceId, whazingQueueId: String(queueId) },
        select: { id: true, agentId: true },
      });
      if (specific) return specific;
    }
    return db.whazingInbox.findFirst({
      where: { tenantId, instanceId, whazingQueueId: null },
      select: { id: true, agentId: true },
    });
  });
  if (!inbox?.agentId) return null;
  return { inboxId: inbox.id, agentId: inbox.agentId };
}
