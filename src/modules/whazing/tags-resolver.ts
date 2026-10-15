import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readIgnoredTagsFromSettings } from "./tags";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

/**
 * Resolves the effective ignored tags for a tenant / instance / agent.
 * Checks agent.settings (and optionally whazingInstance.settings).
 */
export async function resolveIgnoredTags(params: {
  base: PrismaClient;
  tenantId: bigint;
  agentId?: bigint | null;
  instanceId?: bigint | null;
}): Promise<string[]> {
  const { base, tenantId, agentId, instanceId } = params;
  const tagsSet = new Set<string>();

  if (agentId != null) {
    const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { settings: true },
      }),
    );
    if (agent?.settings) {
      for (const t of readIgnoredTagsFromSettings(agent.settings)) {
        tagsSet.add(t);
      }
    }
  }

  if (instanceId != null) {
    const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.whazingInstance.findUnique({
        where: { id: instanceId },
        select: { settings: true },
      }),
    );
    if (instance?.settings) {
      for (const t of readIgnoredTagsFromSettings(instance.settings)) {
        tagsSet.add(t);
      }
    }
  }

  return Array.from(tagsSet);
}
