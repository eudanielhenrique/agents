import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { extractTagValues } from "./tags";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface WhazingSessionConfig {
  sessionTtlHours: number;
  sessionTtlMs: number;
  closingTagIds: number[];
}

export const DEFAULT_SESSION_TTL_HOURS = 24;

/**
 * Extracts session configuration from a Whazing instance settings object.
 */
export function extractSessionConfig(settings: unknown): WhazingSessionConfig {
  if (!settings || typeof settings !== "object") {
    return {
      sessionTtlHours: DEFAULT_SESSION_TTL_HOURS,
      sessionTtlMs: DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000,
      closingTagIds: [],
    };
  }

  const s = settings as Record<string, unknown>;
  const sessionBag =
    typeof s.session === "object" && s.session !== null
      ? (s.session as Record<string, unknown>)
      : s;

  const rawHours = sessionBag.sessionTtlHours ?? s.sessionTtlHours;
  const sessionTtlHours =
    typeof rawHours === "number" && !Number.isNaN(rawHours) && rawHours > 0
      ? Math.min(168, Math.max(1, Math.round(rawHours)))
      : DEFAULT_SESSION_TTL_HOURS;

  const rawTags = sessionBag.closingTagIds ?? s.closingTagIds;
  let closingTagIds: number[] = [];
  if (Array.isArray(rawTags)) {
    closingTagIds = rawTags
      .map((t) => (typeof t === "number" ? t : Number(String(t).trim())))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  return {
    sessionTtlHours,
    sessionTtlMs: sessionTtlHours * 60 * 60 * 1000,
    closingTagIds,
  };
}

/**
 * Loads the session configuration for a given tenant and Whazing instance.
 */
export async function resolveWhazingSessionConfig(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
): Promise<WhazingSessionConfig> {
  try {
    const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.whazingInstance.findUnique({
        where: { id: instanceId },
        select: { settings: true },
      }),
    );
    return extractSessionConfig(instance?.settings);
  } catch {
    return {
      sessionTtlHours: DEFAULT_SESSION_TTL_HOURS,
      sessionTtlMs: DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000,
      closingTagIds: [],
    };
  }
}

/**
 * Checks if any of the candidate tags match the configured closing tags.
 */
export function hasClosingTag(
  candidateTags:
    | Array<number | string | { id?: number | string; name?: string }>
    | undefined,
  closingTagIds: number[],
): boolean {
  if (
    !candidateTags ||
    candidateTags.length === 0 ||
    closingTagIds.length === 0
  ) {
    return false;
  }

  const tagValues = extractTagValues(candidateTags);
  const closingSet = new Set(closingTagIds.map(String));

  for (const v of tagValues) {
    if (closingSet.has(v)) {
      return true;
    }
  }

  return false;
}
