// Whazing intake routing (n8n "recepção inteligente" parity, items 1+2): decide which queue a
// BRAND NEW ticket belongs on (the bot's own queue vs the escalate queue, by prior history / already
// answered) and tag + notify a campaign-sourced lead. Runs once, on the first message we ever see
// for a ticket (no WhazingConversation row yet) — everything after that is covered by the existing
// per-message gate (shouldWhazingBotHandle) and the humanTakeoverAt fast path in webhook.ts.
//
// Whazing has no queue-list / tag-list endpoint (confirmed against the official Postman
// collection) — escalateQueueId/campaignTagId are raw ids the operator reads off the Whazing
// dashboard, same as the existing handoff.whazingQueueId field.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadWhazingClient } from "./instance";
import {
  readWhazingIntakeConfig,
  type WhazingIntakeConfig,
} from "./intake-settings";
import type { NormalizedWhazingEvent, WhazingTicketStatus } from "./types";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface IntakeResolution {
  // The bot's own queue for this instance — where a ticket with no history and not yet answered stays.
  // String per schema; null = catch-all inbox (no queue move).
  botQueueId: string | null;
  intake: WhazingIntakeConfig;
}

// Resolves the Whazing intake routing & campaign config for this instance.
// Primary source: WhazingInstance.settings (decoupled from individual agents).
// Fallback: legacy agent.settings.whazingIntake on a bound inbox, ONLY IF the agent is currently enabled.
export async function resolveWhazingIntake(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
): Promise<IntakeResolution | null> {
  // 1. Check instance-level settings first.
  const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingInstance.findUnique({
      where: { id: instanceId },
      select: { settings: true },
    }),
  );
  if (instance?.settings) {
    const intake = readWhazingIntakeConfig(instance.settings);
    if (intake.historyRoutingEnabled || intake.campaignEnabled) {
      const botQueueId =
        intake.botQueueId != null ? String(intake.botQueueId) : null;
      return { botQueueId, intake };
    }
  }

  // 2. Fallback to legacy agent-bound inboxes (only enabled agents).
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.whazingInbox.findMany({
      where: {
        tenantId,
        instanceId,
        agentId: { not: null },
        agent: { enabled: true },
      },
      select: { whazingQueueId: true, agent: { select: { settings: true } } },
    }),
  );
  const candidates = rows
    .map((r) => ({
      botQueueId: r.whazingQueueId,
      intake: readWhazingIntakeConfig(r.agent?.settings),
    }))
    .filter((r) => r.intake.historyRoutingEnabled || r.intake.campaignEnabled);
  if (candidates.length > 1) {
    logger.warn(
      "whazing intake: more than one enabled agent has whazingIntake routing/campaign enabled for instance=%s tenant=%s — using the first",
      String(instanceId),
      String(tenantId),
    );
  }
  return candidates[0] ?? null;
}

// Whether this contact has an ONGOING other conversation — the actual reason to escalate instead
// of letting the bot answer. Only an OPEN/PENDING other ticket counts: a CLOSED one (even from
// minutes ago) is a finished conversation, not a human currently owning this contact. Counting
// closed tickets here would permanently escalate every future message from any returning
// contact — including one who was fully served before and is now writing in about something new —
// to a queue nobody may be watching, silently dropping them forever (see bug 2026-08-28, tenant
// boraautomatizar: a repeat tester's phone had only closed history and never got a bot reply
// again).
export function hasActivePriorHistory(
  ticketId: number,
  history: Array<{ id: number; status: WhazingTicketStatus }>,
): boolean {
  return history.some((t) => t.id !== ticketId && t.status !== "closed");
}

// Whazing's /ticket/:id return shape is `unknown` at the client boundary (see getTicket) — this
// reads just the one field we need (mirrors n8n's `messages.some(m => m.fromMe === true)`).
function ticketHasHumanReply(ticket: unknown): boolean {
  if (!ticket || typeof ticket !== "object") return false;
  const messages = (ticket as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) =>
      m &&
      typeof m === "object" &&
      (m as Record<string, unknown>).fromMe === true,
  );
}

// Shared with webhook.ts's humanTakeoverAt handling — the escalate queue is the same one item 1
// uses for "already has history", so a manual takeover and a routing decision agree on where a
// ticket lands.
export async function resolveEscalateQueueId(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
): Promise<number | null> {
  const resolved = await resolveWhazingIntake(base, tenantId, instanceId);
  return resolved?.intake.escalateQueueId ?? null;
}

export interface RunWhazingIntakeParams {
  tenantId: bigint;
  instanceId: bigint;
  event: NormalizedWhazingEvent;
  base?: PrismaClient;
}

// Where the CURRENT triggering message ended up, so the caller can react before invoking the
// agent turn for it — moving the ticket to a queue via the Whazing API only affects the NEXT
// message; this event's own (already-received) queueId is stale until then, so the caller must
// route this one turn explicitly instead of relying on it to reflect the move.
export type WhazingIntakeRouting =
  | { routedTo: "skipped" }
  | { routedTo: "escalate" }
  | { routedTo: "bot"; botQueueId: number | null };

// Best-effort by design: every Whazing call is try/caught and logged, never thrown — a failure
// here must not block the bot from answering the message that triggered it.
export async function runWhazingIntake(
  params: RunWhazingIntakeParams,
): Promise<WhazingIntakeRouting> {
  const base = params.base ?? basePrisma;
  const { tenantId, instanceId, event } = params;
  const ticketId = event.ticketId;
  if (ticketId == null) return { routedTo: "skipped" };

  const resolved = await resolveWhazingIntake(base, tenantId, instanceId);
  if (!resolved) return { routedTo: "bot", botQueueId: null };

  const client = await loadWhazingClient(tenantId, instanceId, base);
  const botQueueId =
    resolved.intake.botQueueId != null
      ? resolved.intake.botQueueId
      : resolved.botQueueId != null
        ? Number(resolved.botQueueId)
        : null;
  // Fail CLOSED, not open: if the history/already-answered check cannot be completed, we do not
  // know whether a human already owns this ticket, so the safe default is to let the bot sit this
  // turn out (not to answer as if it were a confirmed-fresh ticket). isKnownTicket stays false
  // (no WhazingConversation row gets created on "skipped"), so the next message retries this check.
  // When history routing is off, there is nothing to fail closed ON — default straight to "bot" so
  // a client with only campaignEnabled never gets stuck re-skipping its own first message forever.
  let routing: WhazingIntakeRouting = resolved.intake.historyRoutingEnabled
    ? { routedTo: "skipped" }
    : { routedTo: "bot", botQueueId };

  if (resolved.intake.historyRoutingEnabled) {
    const phone = event.contact?.phone;
    if (phone) {
      try {
        const history = await client.listTicketsByPhone(phone);
        const hasPriorHistory = hasActivePriorHistory(ticketId, history);
        const currentFromHistory = history.find((t) => t.id === ticketId);
        const alreadyAnswered =
          currentFromHistory?.answered === true ||
          ticketHasHumanReply(await client.getTicket(ticketId));

        if (hasPriorHistory || alreadyAnswered) {
          routing = { routedTo: "escalate" };
          if (resolved.intake.escalateQueueId != null) {
            await client.assignTicketToQueue(
              ticketId,
              resolved.intake.escalateQueueId,
            );
          }
        } else {
          routing = { routedTo: "bot", botQueueId };
          if (botQueueId != null) {
            await client.assignTicketToQueue(ticketId, botQueueId);
          }
        }
      } catch (e) {
        logger.warn(
          {
            ticketId,
            error:
              e instanceof Error ? { message: e.message, name: e.name } : e,
          },
          "whazing intake: routing check failed — skipping this turn (fail closed)",
        );
        routing = { routedTo: "skipped" };
      }
    } else {
      // No phone on the event — cannot run the history check either; same fail-closed default.
      logger.warn(
        { ticketId },
        "whazing intake: no contact phone on event — skipping this turn",
      );
      routing = { routedTo: "skipped" };
    }
  }

  if (resolved.intake.campaignEnabled && event.campaignSignal) {
    const contactId = event.contact?.id;
    if (resolved.intake.campaignTagId != null && contactId != null) {
      try {
        await client.setContactTags(contactId, [
          String(resolved.intake.campaignTagId),
        ]);
      } catch (e) {
        logger.warn(
          { ticketId, error: e },
          "whazing intake: campaign tag failed (non-fatal)",
        );
      }
    }
    if (resolved.intake.campaignNotifyPhone) {
      try {
        const text = resolved.intake.campaignNotifyMessage.replace(
          "{{ctwaClid}}",
          event.campaignSignal.ctwaClid ?? "",
        );
        await client.sendMessageToNumber(
          resolved.intake.campaignNotifyPhone,
          text,
        );
      } catch (e) {
        logger.warn(
          { ticketId, error: e },
          "whazing intake: campaign notify failed (non-fatal)",
        );
      }
    }
  }

  return routing;
}
