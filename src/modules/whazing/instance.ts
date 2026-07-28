import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { hashRouteToken } from "@/modules/webhooks/inbound/route-token";
import { type WhazingClient, createWhazingClient } from "./client";

// Loads a WhazingClient for a tenant's instance with the apiKey decrypted.
// Single place that resolves the instance + decrypts credentials, mirroring
// the Chatwoot loadChatwootClient pattern.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export async function loadWhazingClient(
  tenantId: bigint,
  instanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<WhazingClient> {
  // TODO: Once WhazingInstance model is migrated (#3), replace this stub with a real DB read.
  // The pattern mirrors loadChatwootClient in chatwoot/instance.ts.
  void tenantId;
  void instanceId;
  void base;
  throw new Error("loadWhazingClient: WhazingInstance model not yet migrated (#3)");
}

export interface ResolvedWhazingInstance {
  instanceId: bigint;
  tenantId: bigint;
}

// Resolve a WhazingInstance by its opaque route token hash (constant-time lookup).
// Used by the webhook receiver to authenticate before any tenant context.
export async function resolveInstanceByRouteToken(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ResolvedWhazingInstance | null> {
  // TODO: Once WhazingInstance model is migrated (#3), replace this stub.
  void token;
  void base;
  return null;
}
