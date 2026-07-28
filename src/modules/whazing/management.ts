import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import config from "@/config";
import { whazingWebhookUrl } from "./webhook-mount";

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface WhazingInstanceDto {
  id: string;
  name: string;
  baseUrl: string;
  webhookUrl: string;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhazingInboxDto {
  id: string;
  instanceId: string;
  whazingQueueId: string | null;
  name: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toInstanceDto(r: {
  id: bigint;
  name: string;
  baseUrl: string;
  routeToken: string;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WhazingInstanceDto {
  // routeToken is encryptJson of the plaintext token → decrypt to build the URL.
  const plainToken = decryptJson<string>(r.routeToken);
  return {
    id: String(r.id),
    name: r.name,
    baseUrl: r.baseUrl,
    webhookUrl: whazingWebhookUrl(config.publicUrl, plainToken),
    disconnectedAt: r.disconnectedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toInboxDto(r: {
  id: bigint;
  instanceId: bigint;
  whazingQueueId: string | null;
  name: string | null;
  agentId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}): WhazingInboxDto {
  return {
    id: String(r.id),
    instanceId: String(r.instanceId),
    whazingQueueId: r.whazingQueueId,
    name: r.name,
    agentId: r.agentId ? String(r.agentId) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ── instance select (excludes apiKey) ────────────────────────────────────────

const INSTANCE_SELECT = {
  id: true,
  name: true,
  baseUrl: true,
  routeToken: true,
  disconnectedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ── instances ─────────────────────────────────────────────────────────────────

export async function listWhazingInstances(
  ctx: TenantContext,
  db: PrismaClient = basePrisma,
): Promise<WhazingInstanceDto[]> {
  const rows = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInstance.findMany({
      select: INSTANCE_SELECT,
      orderBy: { createdAt: "desc" },
    }),
  );
  return rows.map(toInstanceDto);
}

export async function getWhazingInstance(
  ctx: TenantContext,
  id: bigint,
  db: PrismaClient = basePrisma,
): Promise<WhazingInstanceDto> {
  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInstance.findFirst({
      where: { id },
      select: INSTANCE_SELECT,
    }),
  );
  if (!row) throw new NotFoundError("Whazing instance not found");
  return toInstanceDto(row);
}

export interface CreateWhazingInstanceInput {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export async function createWhazingInstance(
  ctx: TenantContext,
  input: CreateWhazingInstanceInput,
  db: PrismaClient = basePrisma,
): Promise<WhazingInstanceDto> {
  await assertSafeOutboundUrl(input.baseUrl, { allowHttp: true });
  const { token, hash } = generateRouteToken();
  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInstance.create({
      data: {
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: encryptJson(input.apiKey),
        routeToken: encryptJson(token),
        routeTokenHash: hash,
      },
      select: INSTANCE_SELECT,
    }),
  );
  return toInstanceDto(row);
}

export interface UpdateWhazingInstanceInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
}

export async function updateWhazingInstance(
  ctx: TenantContext,
  id: bigint,
  input: UpdateWhazingInstanceInput,
  db: PrismaClient = basePrisma,
): Promise<WhazingInstanceDto> {
  if (input.baseUrl) {
    await assertSafeOutboundUrl(input.baseUrl, { allowHttp: true });
  }
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.baseUrl !== undefined)
    data.baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (input.apiKey !== undefined) data.apiKey = encryptJson(input.apiKey);

  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInstance.update({
      where: { id },
      data,
      select: INSTANCE_SELECT,
    }),
  );
  return toInstanceDto(row);
}

export async function disconnectWhazingInstance(
  ctx: TenantContext,
  id: bigint,
  db: PrismaClient = basePrisma,
): Promise<WhazingInstanceDto> {
  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInstance.update({
      where: { id },
      data: { disconnectedAt: new Date() },
      select: INSTANCE_SELECT,
    }),
  );
  return toInstanceDto(row);
}

// ── inboxes ───────────────────────────────────────────────────────────────────

const INBOX_SELECT = {
  id: true,
  instanceId: true,
  whazingQueueId: true,
  name: true,
  agentId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listWhazingInboxes(
  ctx: TenantContext,
  instanceId: bigint,
  db: PrismaClient = basePrisma,
): Promise<WhazingInboxDto[]> {
  const rows = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInbox.findMany({
      where: { instanceId },
      select: INBOX_SELECT,
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toInboxDto);
}

export interface CreateWhazingInboxInput {
  whazingQueueId?: string | null;
  name?: string | null;
  agentId?: bigint | null;
}

export async function createWhazingInbox(
  ctx: TenantContext,
  instanceId: bigint,
  input: CreateWhazingInboxInput,
  db: PrismaClient = basePrisma,
): Promise<WhazingInboxDto> {
  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInbox.create({
      data: {
        instanceId,
        whazingQueueId: input.whazingQueueId ?? null,
        name: input.name ?? null,
        agentId: input.agentId ?? null,
      },
      select: INBOX_SELECT,
    }),
  );
  return toInboxDto(row);
}

export interface UpdateWhazingInboxInput {
  whazingQueueId?: string | null;
  name?: string | null;
  agentId?: bigint | null;
}

export async function updateWhazingInbox(
  ctx: TenantContext,
  id: bigint,
  instanceId: bigint,
  input: UpdateWhazingInboxInput,
  db: PrismaClient = basePrisma,
): Promise<WhazingInboxDto> {
  const data: Record<string, unknown> = {};
  if ("whazingQueueId" in input) data.whazingQueueId = input.whazingQueueId;
  if ("name" in input) data.name = input.name;
  if ("agentId" in input) data.agentId = input.agentId;

  const row = await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInbox.update({
      where: { id, instanceId },
      data,
      select: INBOX_SELECT,
    }),
  );
  return toInboxDto(row);
}

export async function deleteWhazingInbox(
  ctx: TenantContext,
  id: bigint,
  instanceId: bigint,
  db: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(db, ctx, (scoped) =>
    scoped.whazingInbox.delete({ where: { id, instanceId } }),
  );
}
