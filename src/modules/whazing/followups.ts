import type { PrismaClient } from "@/../generated/prisma/client";
import { isTurnInFlight } from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isTestSilenced } from "@/modules/agents/test-mode";
import { hasLiveAppointment } from "@/modules/appointments/reminders";
import {
  isOpenAt,
  nextOpenAt,
  parseWindows,
} from "@/modules/business-hours/hours";
import {
  isNewFollowUpEpisode,
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import type { JobResult } from "@/modules/scheduler/worker";
import { runWhazingAgentNudge } from "./nudge";

// Whazing's follow-up (reengagement) sweep + handler. Parallel to src/modules/followups/handlers.ts
// but reads WhazingConversation instead of Conversation, and has no channelRedirect concept (that
// feature is Chatwoot-widget-specific). Reuses the SAME "FOLLOWUP"/"FOLLOWUP_SWEEP" scheduler job
// kinds and payload shape ({threadId}) — dispatched by threadId shape in followups/handlers.ts,
// same pattern as the appointments/reminders.ts Whazing dispatch.

const APPOINTMENT_BACKOFF_MS = 3_600_000;
const IN_FLIGHT_BACKOFF_MS = 30_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface WhazingFollowUpLiveness {
  agentEnabled: boolean;
  followUpEnabled: boolean;
  agentMode: string;
  testActivatedAt: Date | null;
  humanTakeoverAt: Date | null;
  assignedUserId: number | null;
}

// Mirrors followups/eligibility.ts's isFollowUpLive, without managedByRedirect (no channel-redirect
// concept for Whazing) and using humanTakeoverAt/assignedUserId instead of shouldBotHandle's
// Chatwoot status/assigneeType vocabulary.
export function isWhazingFollowUpLive(s: WhazingFollowUpLiveness): boolean {
  return (
    s.agentEnabled &&
    s.followUpEnabled &&
    !isTestSilenced(s.agentMode, s.testActivatedAt) &&
    s.humanTakeoverAt == null &&
    s.assignedUserId == null
  );
}

// Scans whazing_conversations for inactive, bot-owned, follow-up-eligible tickets and enqueues one
// FOLLOWUP job per thread — the Whazing counterpart of the raw SQL scan in followups/handlers.ts's
// sweepHandler, called from the same tick with the same tenant-wide cutoff.
export async function sweepWhazingFollowUps(
  tenantId: bigint,
  cutoffMin: number,
  base: PrismaClient,
): Promise<void> {
  const cutoff = new Date(Date.now() - cutoffMin * 60_000);
  const threads = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$queryRaw<Array<{ thread_id: string }>>`
      SELECT wc.thread_id
      FROM whazing_conversations wc
      JOIN whazing_inboxes wi ON wi.id = wc.inbox_id
      JOIN agents a ON a.id = wi.agent_id
      WHERE wc.tenant_id = ${tenantId}
        AND wc.human_takeover_at IS NULL
        AND wc.assigned_user_id IS NULL
        AND wc.inbox_id IS NOT NULL
        AND a.enabled = true
        AND (a.mode <> 'test' OR wc.test_activated_at IS NOT NULL)
        AND wc.last_event_at < ${cutoff}
        AND wc.last_inbound_at IS NOT NULL
        AND (
          wc.last_follow_up_at IS NULL
          OR wc.last_inbound_at > wc.last_follow_up_at
        )
        AND a.follow_up_armed_at IS NOT NULL
        AND wc.last_inbound_at >= a.follow_up_armed_at
        AND NOT (
          coalesce(a.settings->'followUp'->>'pauseWhileAppointment', 'true') <> 'false'
          AND EXISTS (
            SELECT 1
            FROM scheduler_jobs sj
            CROSS JOIN LATERAL (
              SELECT CASE
                WHEN sj.payload->>'startISO' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN sj.payload->>'startISO' || 'T00:00:00Z'
                WHEN sj.payload->>'startISO' ~ '[Tt ][0-9]{2}:'
                     AND sj.payload->>'startISO' !~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$'
                  THEN sj.payload->>'startISO' || 'Z'
                ELSE sj.payload->>'startISO'
              END AS start_iso
            ) norm
            WHERE sj.tenant_id = wc.tenant_id
              AND sj.kind = 'APPOINTMENT_REMINDER'
              AND sj.payload->>'threadId' = wc.thread_id
              AND sj.payload->>'cancelledAt' IS NULL
              AND (
                sj.status IN ('PENDING', 'CLAIMED')
                OR CASE
                  WHEN norm.start_iso IS NOT NULL
                       AND pg_input_is_valid(norm.start_iso, 'timestamptz')
                    THEN norm.start_iso::timestamptz > now()
                  ELSE false
                END
              )
          )
        )
      LIMIT 500
    `,
  );
  for (const t of threads) {
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: `followup:${t.thread_id}`,
      runAt: new Date(),
      payload: { threadId: t.thread_id },
      base,
    });
  }
}

export async function handleWhazingFollowUp(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<JobResult> {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return { outcome: "done" };
  const tenantId = job.tenantId;

  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.whazingConversation.findFirst({
      where: { tenantId, threadId },
      select: {
        id: true,
        lastEventAt: true,
        lastInboundAt: true,
        lastFollowUpAt: true,
        humanTakeoverAt: true,
        assignedUserId: true,
        testActivatedAt: true,
        agentId: true,
      },
    });
    if (!conv?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: conv.agentId },
      select: {
        enabled: true,
        mode: true,
        settings: true,
        businessHoursId: true,
        followUpHoursId: true,
        followUpArmedAt: true,
      },
    });
    if (!agent) return null;
    const followUpCfg = readFollowUpConfig(agent.settings);
    if (
      !isWhazingFollowUpLive({
        agentEnabled: agent.enabled,
        followUpEnabled: followUpCfg.enabled,
        agentMode: agent.mode,
        testActivatedAt: conv.testActivatedAt,
        humanTakeoverAt: conv.humanTakeoverAt,
        assignedUserId: conv.assignedUserId,
      })
    ) {
      return null;
    }
    const hoursId = agent.followUpHoursId ?? agent.businessHoursId;
    const hours = hoursId
      ? await db.businessHours.findUnique({
          where: { id: hoursId },
          select: { windows: true, timezone: true },
        })
      : null;
    return { conv, followUpCfg, hours, armedAt: agent.followUpArmedAt };
  });
  if (!ctx) return { outcome: "done" };

  if (ctx.followUpCfg.pauseWhileAppointment) {
    const blockedByAppointment = await hasLiveAppointment(
      tenantId,
      threadId,
      base,
    );
    if (blockedByAppointment) {
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + APPOINTMENT_BACKOFF_MS),
      };
    }
  }

  const steps = ctx.followUpCfg.steps;
  const stepIndex =
    typeof job.payload.stepIndex === "number" &&
    Number.isInteger(job.payload.stepIndex)
      ? job.payload.stepIndex
      : 0;
  const step = steps[stepIndex];
  if (!step) return { outcome: "done" };

  const { lastFollowUpAt, lastInboundAt, lastEventAt } = ctx.conv;

  const newEpisode = isNewFollowUpEpisode(lastFollowUpAt, lastInboundAt);
  if (stepIndex === 0) {
    if (!newEpisode) return { outcome: "done" };
    if (
      ctx.armedAt == null ||
      lastInboundAt == null ||
      lastInboundAt < ctx.armedAt
    ) {
      return { outcome: "done" };
    }
  } else if (newEpisode) {
    return { outcome: "done" };
  }

  const anchor = stepIndex === 0 ? lastEventAt : lastFollowUpAt;
  if (anchor) {
    const dueAt = anchor.getTime() + stepDelayMinutes(step) * 60_000;
    if (Date.now() < dueAt) {
      return { outcome: "reschedule", runAt: new Date(dueAt) };
    }
  }

  if (ctx.hours) {
    const windows = parseWindows(ctx.hours.windows);
    const now = new Date();
    if (windows.length > 0 && !isOpenAt(windows, ctx.hours.timezone, now)) {
      const next = nextOpenAt(windows, ctx.hours.timezone, now);
      if (next) return { outcome: "reschedule", runAt: next };
      return { outcome: "done" };
    }
  }

  if (isTurnInFlight(threadId)) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + IN_FLIGHT_BACKOFF_MS),
    };
  }

  const idleMin = lastEventAt
    ? Math.round((Date.now() - lastEventAt.getTime()) / 60_000)
    : stepDelayMinutes(step);
  const nudgeOutcome = await runWhazingAgentNudge({
    tenantId,
    threadId,
    nudge: {
      source: "followup",
      kind: "inactivity",
      summary: `The customer has been inactive for about ${idleMin} minutes.`,
      instructions: step.instructions || undefined,
      step: stepIndex + 1,
    },
    base,
    deps,
  });

  // "stale"/"no-agent": no longer bot-owned or the inbox/agent resolution failed — episode is moot.
  if (nudgeOutcome === "stale" || nudgeOutcome === "no-agent") {
    return { outcome: "done" };
  }

  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingConversation.update({
      where: { id: ctx.conv.id },
      data: { lastFollowUpAt: new Date() },
    }),
  );

  // Outside the window, WhazingClient can't send a template yet — the fallback note ends the
  // sequence, same reasoning as Chatwoot's "noted-window": every further step would be equally
  // undeliverable, and a customer reply (which reopens the window) already ends the episode anyway.
  if (nudgeOutcome === "noted-window") return { outcome: "done" };

  const nextIndex = stepIndex + 1;
  const nextStep = steps[nextIndex];
  if (nextStep) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + stepDelayMinutes(nextStep) * 60_000),
      payload: { threadId, stepIndex: nextIndex },
    };
  }
  return { outcome: "done" };
}
