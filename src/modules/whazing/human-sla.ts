import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { loadWhazingClient } from "./instance";
import { runWhazingAgentTurn } from "./runtime";
import type { NormalizedWhazingEvent } from "./types";

export interface HumanSlaConfig {
  enabled: boolean;
  minutes: number;
  timeoutMinutes: number;
  hoursId: number | null;
  escalateQueueId: number | null;
  botQueueId: number | null;
  bypassOutOfHours: boolean;
}

export type WhazingHumanSlaConfig = HumanSlaConfig;

export const HUMAN_SLA_DEFAULTS: HumanSlaConfig = {
  enabled: false,
  minutes: 5,
  timeoutMinutes: 5,
  hoursId: null,
  escalateQueueId: null,
  botQueueId: null,
  bypassOutOfHours: true,
};

export const WHAZING_HUMAN_SLA_DEFAULTS = HUMAN_SLA_DEFAULTS;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number, min = 1, max = 1440): number {
  if (typeof v === "number" && !Number.isNaN(v)) {
    return Math.max(min, Math.min(max, Math.round(v)));
  }
  if (typeof v === "string") {
    const parsed = Number.parseInt(v, 10);
    if (!Number.isNaN(parsed)) {
      return Math.max(min, Math.min(max, parsed));
    }
  }
  return fallback;
}

function idRef(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function readHumanSlaConfig(settings: unknown): HumanSlaConfig {
  if (!settings || typeof settings !== "object") {
    return { ...HUMAN_SLA_DEFAULTS };
  }
  const rec = settings as Record<string, unknown>;
  const s =
    rec.humanSla && typeof rec.humanSla === "object"
      ? rec.humanSla
      : rec.sla && typeof rec.sla === "object"
        ? rec.sla
        : "minutes" in rec || "timeoutMinutes" in rec || "enabled" in rec
          ? rec
          : undefined;

  if (!s || typeof s !== "object") return { ...HUMAN_SLA_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const D = HUMAN_SLA_DEFAULTS;

  const minutes = num(
    bag.minutes ?? bag.timeoutMinutes ?? bag.timeout,
    D.minutes,
  );

  return {
    enabled: bool(bag.enabled ?? bag.humanSlaEnabled, D.enabled),
    minutes,
    timeoutMinutes: minutes,
    hoursId: idRef(bag.hoursId),
    escalateQueueId: idRef(bag.escalateQueueId),
    botQueueId: idRef(bag.botQueueId),
    bypassOutOfHours: bool(bag.bypassOutOfHours, D.bypassOutOfHours),
  };
}

export const readWhazingHumanSlaConfig = readHumanSlaConfig;

export async function resolveInstanceHumanSla(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
): Promise<HumanSlaConfig | null> {
  const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingInstance.findUnique({
      where: { id: instanceId },
      select: { settings: true },
    }),
  );

  if (instance?.settings) {
    const cfg = readHumanSlaConfig(instance.settings);
    if (cfg.enabled) return cfg;
  }

  const inboxes = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingInbox.findMany({
      where: {
        tenantId,
        instanceId,
        agentId: { not: null },
        agent: { enabled: true },
      },
      select: { agent: { select: { settings: true } } },
    }),
  );

  for (const inbox of inboxes) {
    if (inbox.agent?.settings) {
      const cfg = readHumanSlaConfig(inbox.agent.settings);
      if (cfg.enabled) return cfg;
    }
  }

  return null;
}

export interface WhazingTicketMessage {
  id: string;
  body: string;
  fromMe: boolean;
  createdAt: string | Date;
  mediaType?: string;
}

export function extractLastTicketMessage(
  ticket: unknown,
): WhazingTicketMessage | null {
  if (!ticket || typeof ticket !== "object") return null;
  const messages = (ticket as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let latest: Record<string, unknown> | null = null;
  let latestTime = 0;

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const createdStr = msg.createdAt;
    const time = createdStr ? new Date(createdStr as string).getTime() : 0;
    if (time >= latestTime) {
      latestTime = time;
      latest = msg;
    }
  }

  if (!latest) return null;

  return {
    id: String(latest.id ?? ""),
    body: String(latest.body ?? latest.messageBody ?? ""),
    fromMe: latest.fromMe === true,
    createdAt: latest.createdAt as string,
    mediaType: typeof latest.mediaType === "string" ? latest.mediaType : "chat",
  };
}

const HUMAN_SLA_INTERVAL_MS = 60_000; // 1 minute

export async function whazingHumanSlaHandler(
  _job: ClaimedJob,
  _base: PrismaClient = basePrisma,
): Promise<JobResult> {
  return { outcome: "done" };
}

async function _disabledWhazingHumanSlaHandler(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const ctx = sysCtx(tenantId);

  try {
    const instances = await runScopedOn(base, ctx, (db) =>
      db.whazingInstance.findMany({
        where: { tenantId },
        select: { id: true, settings: true },
      }),
    );

    for (const inst of instances) {
      const slaConfig = await resolveInstanceHumanSla(base, tenantId, inst.id);
      if (!slaConfig?.enabled) continue;

      const cutoff = new Date(Date.now() - slaConfig.minutes * 60_000);

      const candidates = await runScopedOn(base, ctx, (db) =>
        db.whazingConversation.findMany({
          where: {
            tenantId,
            instanceId: inst.id,
            status: { notIn: ["resolved", "closed"] },
            lastInboundAt: { lte: cutoff },
          },
          select: {
            id: true,
            ticketId: true,
            contactId: true,
            contactName: true,
            contactPhone: true,
            humanTakeoverAt: true,
            lastInboundAt: true,
            lastFollowUpAt: true,
            inboxId: true,
            inbox: { select: { whazingQueueId: true } },
          },
        }),
      );

      for (const conv of candidates) {
        if (
          conv.lastFollowUpAt &&
          conv.lastInboundAt &&
          conv.lastFollowUpAt >= conv.lastInboundAt
        ) {
          continue;
        }

        try {
          const client = await loadWhazingClient(tenantId, inst.id, base);
          const rawTicket = await client.getTicket(conv.ticketId);
          const lastMsg = extractLastTicketMessage(rawTicket);

          if (!lastMsg || lastMsg.fromMe) {
            continue;
          }

          const msgTime = new Date(lastMsg.createdAt).getTime();
          if (Date.now() - msgTime < slaConfig.minutes * 60_000) {
            continue;
          }

          logger.info(
            "whazing human SLA: triggering bot takeover for ticket=%d after %d min inactivity",
            conv.ticketId,
            slaConfig.minutes,
          );

          const targetBotQueue =
            slaConfig.botQueueId ??
            (conv.inbox?.whazingQueueId
              ? Number(conv.inbox.whazingQueueId)
              : null);

          if (targetBotQueue != null) {
            await client.assignTicketToQueue(conv.ticketId, targetBotQueue);
          }

          await runScopedOn(base, ctx, (db) =>
            db.whazingConversation.update({
              where: { id: conv.id },
              data: {
                humanTakeoverAt: null,
                lastFollowUpAt: new Date(),
              },
            }),
          );

          const event: NormalizedWhazingEvent = {
            event: "message_received",
            ticketId: conv.ticketId,
            queueId: targetBotQueue,
            assignedUserId: null,
            status: "pending",
            sendType: null,
            campaignSignal: null,
            message: {
              id: lastMsg.id,
              body: lastMsg.body,
              fromMe: false,
              isAutomation: false,
              attachments: [],
              timestamp: Math.round(
                new Date(lastMsg.createdAt).getTime() / 1000,
              ),
            },
            contact: {
              id: conv.contactId,
              name: conv.contactName,
              phone: conv.contactPhone,
              whatsappId: null,
            },
          };

          const outcome = await runWhazingAgentTurn({
            tenantId,
            instanceId: inst.id,
            event,
            base,
          });

          logger.info(
            "whazing human SLA: turn completed ticket=%d outcome=%s",
            conv.ticketId,
            outcome,
          );
        } catch (ticketErr) {
          logger.warn(
            { ticketId: conv.ticketId, error: ticketErr },
            "whazing human SLA: failed processing conversation (non-fatal)",
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "whazing human SLA sweep failed");
  }

  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + HUMAN_SLA_INTERVAL_MS),
  };
}

let registered = false;
export function registerWhazingHumanSlaHandler(): void {
  if (registered) return;
  registerJobHandler("WHAZING_HUMAN_SLA", whazingHumanSlaHandler);
  registered = true;
}

export async function ensureWhazingHumanSla(
  _tenantId: bigint,
  _base: PrismaClient = basePrisma,
): Promise<void> {
  // Permanently disabled
}

export async function ensureAllWhazingHumanSla(
  _base: PrismaClient = basePrisma,
): Promise<void> {
  // Permanently disabled
}
