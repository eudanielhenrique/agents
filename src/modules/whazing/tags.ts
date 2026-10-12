import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

/**
 * Extracts string tag identifiers or names from any tag shape:
 * - number: 71 -> ["71"]
 * - string: "71" -> ["71"]
 * - object: { id: 71, name: "Suporte" } -> ["71", "suporte"]
 * - array of any of the above
 */
export function extractTagValues(raw: unknown): string[] {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === "number" || typeof item === "string") {
      const s = String(item).trim();
      if (s) result.push(s);
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (obj.id != null) {
        const s = String(obj.id).trim();
        if (s) result.push(s);
      }
      if (obj.tagId != null) {
        const s = String(obj.tagId).trim();
        if (s) result.push(s);
      }
      if (typeof obj.name === "string" && obj.name.trim()) {
        result.push(obj.name.trim());
      }
    }
  }
  return result;
}

/**
 * Checks whether candidate tags include any of the ignored tags.
 * Comparison is case-insensitive, trimmed string comparison.
 */
export function hasIgnoredTag(
  candidateTags: unknown,
  ignoredTags: Array<number | string> | null | undefined,
): boolean {
  if (!ignoredTags || ignoredTags.length === 0) return false;
  const candidates = extractTagValues(candidateTags);
  if (candidates.length === 0) return false;

  const ignoredSet = new Set(
    ignoredTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean),
  );
  if (ignoredSet.size === 0) return false;

  return candidates.some((cand) => ignoredSet.has(cand.toLowerCase()));
}

export function readIgnoredTagsFromSettings(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const s = settings as Record<string, unknown>;
  const raw =
    s.ignoredTags ??
    s.excludedTags ??
    (s.whazingIntake && typeof s.whazingIntake === "object"
      ? ((s.whazingIntake as Record<string, unknown>).ignoredTags ??
        (s.whazingIntake as Record<string, unknown>).excludedTags)
      : undefined);
  return extractTagValues(raw);
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
