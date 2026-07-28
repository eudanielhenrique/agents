import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import { type WhazingClient, createWhazingClient } from "./client";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Loads a WhazingClient for a tenant's instance with the apiKey decrypted.
// Mirrors the loadChatwootClient pattern. Throws if the instance is missing or disconnected.
export async function loadWhazingClient(
  tenantId: bigint,
  instanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<WhazingClient> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingInstance.findUnique({
      where: { id: instanceId },
      select: { baseUrl: true, apiKey: true, disconnectedAt: true },
    }),
  );
  if (!row)
    throw new Error(`WhazingInstance ${instanceId} not found for tenant ${tenantId}`);
  if (row.disconnectedAt !== null)
    throw new Error(`WhazingInstance ${instanceId} is disconnected`);
  const apiKey = decryptJson<string>(row.apiKey);
  return createWhazingClient({ baseUrl: row.baseUrl, apiKey });
}

export interface ResolvedWhazingInstance {
  instanceId: bigint;
  tenantId: bigint;
}

// Resolves a WhazingInstance by its opaque route token (constant-time hash probe).
// Used by the webhook receiver before any tenant context is established.
// Returns null for unknown tokens and disconnected instances.
export async function resolveInstanceByRouteToken(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ResolvedWhazingInstance | null> {
  const webhookRouteTokenHash = hashRouteToken(token);
  const row = await asSuperAdminOn(base, (db) =>
    db.whazingInstance.findUnique({
      where: { webhookRouteTokenHash },
      select: { id: true, tenantId: true, disconnectedAt: true },
    }),
  );
  if (!row) return null;
  if (row.disconnectedAt !== null) return null;
  return { instanceId: row.id, tenantId: row.tenantId };
}
