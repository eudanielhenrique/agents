import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { markTurnInFlight } from "@/graph/inflight";
import { loadAgentConfig } from "@/graph/prepare";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type DebounceConfig,
  readDebounceConfig,
} from "@/modules/debounce/settings";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  type JobResult,
  registerDeadLetterHandler,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import { looksLikePersonName } from "@/modules/whazing/contact-name";
import { resolveWhazingInboxAndAgent } from "./inbox-resolve";
import { loadWhazingClient } from "./instance";
import { runWhazingTurnTail } from "./runtime";

// Whazing's debounce/coalescing. Parallel to src/modules/debounce/* but NOT a re-fetch-from-source
// design like Chatwoot's: WhazingClient.getTicket() returns an untyped, never-captured message-list
// shape, so there is nothing trustworthy to re-fetch and parse at flush time. Instead each arm
// BUFFERS the already-rendered text (same renderWhazingMessage + STT the direct path already runs)
// into the job payload; the flush just joins them and answers once. This also structurally fixes the
// race that dropped a message in production: only ONE inbox/agent resolution happens per burst (at
// flush time), instead of one independent resolution per message that could catch the ticket's queue
// mid-move by the bot's own handoff call.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function whazingDebounceDedupeKey(threadId: string): string {
  return `whazing-debounce:${threadId}`;
}

// Resolves the debounce config for the given agent. Returns null when the agent is disabled or has
// debounce turned off — the caller then takes the direct (no-coalesce) path.
export async function resolveWhazingDebounceConfig(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<DebounceConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readDebounceConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface WhazingDebouncePayload {
  threadId: string;
  ticketId: number;
  instanceId: string; // bigint as string — JSON-safe
  queueId: number | null;
  texts: string[];
  burstStartedAt: number;
  contactId: number | null;
  rawContactName: string | null;
}

export function parseWhazingDebouncePayload(
  payload: unknown,
): WhazingDebouncePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.threadId !== "string" ||
    typeof p.ticketId !== "number" ||
    typeof p.instanceId !== "string" ||
    !Array.isArray(p.texts)
  ) {
    return null;
  }
  return {
    threadId: p.threadId,
    ticketId: p.ticketId,
    instanceId: p.instanceId,
    queueId: typeof p.queueId === "number" ? p.queueId : null,
    texts: p.texts.filter((t): t is string => typeof t === "string"),
    burstStartedAt:
      typeof p.burstStartedAt === "number" ? p.burstStartedAt : Date.now(),
    contactId: typeof p.contactId === "number" ? p.contactId : null,
    rawContactName:
      typeof p.rawContactName === "string" ? p.rawContactName : null,
  };
}

export interface ArmWhazingDebounceParams {
  tenantId: bigint;
  threadId: string;
  ticketId: number;
  instanceId: bigint;
  queueId: number | null;
  text: string;
  contactId: number | null;
  rawContactName: string | null;
  cfg: DebounceConfig;
  base?: PrismaClient;
  now?: Date;
}

// Re-arms the per-thread WHAZING_DEBOUNCE job: runAt = min(now + window, burstStart + maxWindow),
// same formula as the Chatwoot arm. Each call APPENDS its rendered text (capped at
// maxMessagesPerBurst — oldest dropped first) instead of re-fetching from Whazing later. Serialized
// per thread by an advisory lock so concurrent deliveries for the same ticket cannot lose a text.
export async function armWhazingDebounce(
  params: ArmWhazingDebounceParams,
): Promise<Date> {
  const { tenantId, threadId, cfg } = params;
  const base = params.base ?? basePrisma;
  const nowMs = (params.now ?? new Date()).getTime();
  const dedupeKey = whazingDebounceDedupeKey(threadId);
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `whazing-debounce-arm:${threadId}`, async () => {
      const existing = await db.schedulerJob.findFirst({
        where: { kind: "WHAZING_DEBOUNCE", dedupeKey },
        select: { status: true, payload: true },
      });
      const prev =
        existing?.status === "PENDING"
          ? parseWhazingDebouncePayload(existing.payload)
          : null;
      const burstStartedAt = prev?.burstStartedAt ?? nowMs;
      const texts = [...(prev?.texts ?? []), params.text].slice(
        -cfg.maxMessagesPerBurst,
      );
      const runAtMs = Math.min(
        nowMs + cfg.windowSeconds * 1000,
        burstStartedAt + cfg.maxWindowSeconds * 1000,
      );
      const payload = {
        threadId,
        ticketId: params.ticketId,
        instanceId: params.instanceId.toString(),
        queueId: params.queueId,
        texts,
        burstStartedAt,
        contactId: params.contactId,
        rawContactName: params.rawContactName,
      } satisfies Prisma.InputJsonObject;
      await db.schedulerJob.upsert({
        where: {
          tenantId_kind_dedupeKey: {
            tenantId,
            kind: "WHAZING_DEBOUNCE",
            dedupeKey,
          },
        },
        create: {
          tenantId,
          kind: "WHAZING_DEBOUNCE",
          dedupeKey,
          runAt: new Date(runAtMs),
          status: "PENDING",
          payload,
        },
        update: {
          runAt: new Date(runAtMs),
          status: "PENDING",
          lastError: null,
          payload,
        },
      });
      return new Date(runAtMs);
    }),
  );
}

export async function flushWhazingDebounceJob(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const payload = parseWhazingDebouncePayload(job.payload);
  if (!payload || payload.texts.length === 0) return { outcome: "done" };
  const tenantId = job.tenantId;
  const instanceId = BigInt(payload.instanceId);
  const { threadId, ticketId } = payload;

  // Resolve the WhazingInbox fresh, exactly like the direct path's head (runtime.ts) — same
  // priority (matching queueId → catch-all). Only ONE resolution per burst, which is the actual
  // fix: no independent per-message resolution left to race the bot's own handoff queue-move.
  const inbox = await resolveWhazingInboxAndAgent(
    base,
    tenantId,
    instanceId,
    payload.queueId,
  );
  if (!inbox) return { outcome: "done" };
  const agentId = inbox.agentId;

  const promptVars = looksLikePersonName(payload.rawContactName)
    ? { nome_contato: payload.rawContactName as string }
    : undefined;
  const loaded = await runScopedOn(base, sysCtx(tenantId), (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId: BigInt(0),
        conversationId: ticketId,
        agentId,
        threadId,
      },
      { overrides: promptVars ? { promptVars } : undefined },
    ),
  );
  if (!loaded) return { outcome: "done" };

  // The direct path upserts the WhazingConversation mirror on every arm (before the debounce
  // decision runs), so the row already exists — just look up its id for flow/error attribution.
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.findUnique({
      where: {
        tenantId_instanceId_ticketId: { tenantId, instanceId, ticketId },
      },
      select: { id: true },
    }),
  );
  const whazingConvId = conv?.id ?? null;
  if (whazingConvId != null) loaded.conversationDbId = whazingConvId;

  const client = await loadWhazingClient(tenantId, instanceId, base);

  let text = payload.texts.join("\n");
  if (payload.contactId != null) {
    const contact = await client
      .getContact(payload.contactId)
      .catch(() => null);
    if (contact && contact.extraInfo.length > 0) {
      const known = contact.extraInfo
        .map((f) => `${f.name}: ${f.value}`)
        .join("; ");
      text = `[Dados já coletados sobre este paciente — NÃO pergunte de novo: ${known}]\n\n${text}`;
    }
  }

  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: whazingConvId,
    agentId,
    inboxId: null,
    threadId,
    base,
  };
  emitFlowEvent(flow, {
    stage: "debounce",
    level: "info",
    status: "ok",
    detail: { coalesced: payload.texts.length },
  });

  markTurnInFlight(threadId);
  try {
    const outcome = await runWhazingTurnTail({
      tenantId,
      instanceId,
      ticketId,
      threadId,
      loaded,
      text,
      client,
      contactId: payload.contactId ?? undefined,
      whazingConvId,
      flow,
      base,
    });
    logger.info(
      "whazing debounce flush: ticket=%s msgs=%d outcome=%s",
      String(ticketId),
      payload.texts.length,
      outcome,
    );
    return { outcome: "done" };
  } catch (e) {
    return {
      outcome: "fail",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

let registered = false;
export function registerWhazingDebounceHandler(): void {
  if (registered) return;
  registerJobHandler("WHAZING_DEBOUNCE", flushWhazingDebounceJob);
  registerDeadLetterHandler("WHAZING_DEBOUNCE", async (job, error) => {
    logger.error(
      "whazing debounce flush dead-lettered (ticket=%s): %s",
      String(job.payload.ticketId),
      error,
    );
  });
  registered = true;
}
