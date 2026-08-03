import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { modelConfigSchema } from "@/graph/model-config";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isTestSilenced } from "@/modules/agents/test-mode";
import {
  isOutOfHoursNow,
  nextOpenAt,
  parseWindows,
} from "@/modules/business-hours/hours";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { shouldBotHandle } from "@/modules/chatwoot/normalize";
import type { FollowUpDelayUnit } from "@/modules/followups/settings";
import {
  isNewFollowUpEpisode,
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";
import { loadWhazingClient } from "@/modules/whazing/instance";

// Read projection of the Conversation mirror for the operational UI + (future) fleet. The mirror
// holds METADATA ONLY — no message bodies — so the heavy PII (conversation content) is never even
// stored here. The one PII field is the contact's display name, which a same-tenant operator
// legitimately needs; tenant isolation is enforced by the scoped read (a tenant never sees
// another's rows).
// NOTE: a SUPER_ADMIN cross-tenant projection must strip the contact name; that gate lands with
// the fleet/super-admin views. For now this endpoint serves the operator's OWN tenant.

const CONVERSATION_STATUSES = [
  "open",
  "pending",
  "resolved",
  "snoozed",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ListConversationsFilter {
  status?: string;
  limit?: number;
  // Keyset cursor: the id of the last item from the previous page. The next page continues from just
  // past it in the (lastEventAt desc, id desc) ordering.
  cursor?: string;
  // Free-text search: matches the contact display name or the Chatwoot conversation id (see
  // buildConversationsWhere). No message-body search — the mirror holds metadata only.
  q?: string;
}

// Transport discriminator: "chatwoot" rows come from the Conversation table, "whazing" from WhazingConversation.
// IDs are namespaced: "c_<bigint>" for Chatwoot, "w_<bigint>" for Whazing.
export type ConversationTransport = "chatwoot" | "whazing";

export interface ConversationListItem {
  id: string;
  transport: ConversationTransport;
  threadId: string;
  chatwootConversationId: number;
  // Whazing-only; null for Chatwoot rows.
  whazingTicketId: number | null;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  // Human assignee display name (null when AI-handled / unassigned) — shown instead of "Human #id".
  assigneeName: string | null;
  lastEventAt: string | null;
  // Last agent-turn failure (sanitized) + when, for the operator's error badge + re-engage action.
  lastError: string | null;
  lastErrorAt: string | null;
  inbox: { id: string; name: string } | null;
  contact: { name: string | null } | null;
  // The bound persona's name, so the list can show it for AI-handled rows. Null when no agent bound.
  agentName: string | null;
  // True when the bound agent's availability schedule is currently closed (item 23). Computed
  // server-side; false when no agent / no schedule.
  outOfHours: boolean;
}

export interface ConversationsPage {
  items: ConversationListItem[];
  // Pass back as `cursor` to fetch the next (older) page; null when this is the last page.
  nextCursor: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function normalizeStatus(status: string | undefined): string | undefined {
  return status && (CONVERSATION_STATUSES as readonly string[]).includes(status)
    ? status
    : undefined;
}

// Cursor format: "t:{unixMs}" — the lastEventAt of the last item on the previous page.
// Items older than the cursor timestamp appear on the next page.
// Legacy BigInt cursors (from before the dual-transport merge) parse to null (start from page 1).
function parseTsCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;
  if (cursor.startsWith("t:")) {
    const ms = Number(cursor.slice(2));
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return null;
}

// Combine the status filter with an optional free-text search. Search matches the contact display
// name (case-insensitive substring) OR, for an all-digit query, the Chatwoot conversation id
// (operators reference conversations by their Chatwoot #id). No message-body search — the mirror
// holds metadata only.
function buildConversationsWhere(
  status: string | undefined,
  q: string | undefined,
  cursorTs: Date | null,
): Prisma.ConversationWhereInput {
  const where: Prisma.ConversationWhereInput = {};
  if (status) where.status = status;
  if (cursorTs) where.lastEventAt = { lt: cursorTs };
  const term = q?.trim();
  if (term) {
    const or: Prisma.ConversationWhereInput[] = [
      { contact: { name: { contains: term, mode: "insensitive" } } },
    ];
    if (/^\d+$/.test(term)) {
      const n = Number(term);
      if (Number.isSafeInteger(n)) or.push({ chatwootConversationId: n });
    }
    where.OR = or;
  }
  return where;
}

// Whazing conversations where clause — parallel to buildConversationsWhere but for WhazingConversation.
function buildWhazingConversationsWhere(
  status: string | undefined,
  q: string | undefined,
  cursorTs: Date | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // @ts-ignore — WhazingConversation types regenerate at build time
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (cursorTs) where.lastEventAt = { lt: cursorTs };
  const term = q?.trim();
  if (term) {
    // @ts-ignore
    const or: unknown[] = [
      { contactName: { contains: term, mode: "insensitive" } },
    ];
    if (/^\d+$/.test(term)) {
      const n = Number(term);
      if (Number.isSafeInteger(n)) or.push({ ticketId: n });
    }
    where.OR = or;
  }
  return where;
}

// Namespaced conversation id → transport + raw row id. `c_{bigint}` (Chatwoot) / `w_{bigint}`
// (Whazing); a bare numeric id is treated as legacy Chatwoot for back-compat. Single source for
// every caller that accepts a cross-transport conversation id (v1 REST, MCP read tools) — keep
// them routing through this instead of re-deriving the prefix scheme.
export function parseConvId(
  raw: string,
): { transport: "chatwoot" | "whazing"; id: bigint } {
  if (raw.startsWith("w_")) return { transport: "whazing", id: BigInt(raw.slice(2)) };
  if (raw.startsWith("c_")) return { transport: "chatwoot", id: BigInt(raw.slice(2)) };
  return { transport: "chatwoot", id: BigInt(raw) };
}

export async function listConversations(
  ctx: TenantContext,
  filter: ListConversationsFilter,
  base: PrismaClient = basePrisma,
): Promise<ConversationsPage> {
  const take = clampLimit(filter.limit);
  const status = normalizeStatus(filter.status);
  const cursorTs = parseTsCursor(filter.cursor);
  const chatwootWhere = buildConversationsWhere(status, filter.q, cursorTs);
  const whazingWhere = buildWhazingConversationsWhere(status, filter.q, cursorTs);

  // Fetch take+1 from each source so we can detect "has more" without a count query.
  const [chatwootRows, whazingRows] = await Promise.all([
    runScopedOn(base, ctx, (db) =>
      db.conversation.findMany({
        where: chatwootWhere,
        orderBy: [
          { lastEventAt: { sort: "desc", nulls: "last" } },
          { id: "desc" },
        ],
        take: take + 1,
        select: {
          id: true,
          threadId: true,
          chatwootConversationId: true,
          status: true,
          assigneeId: true,
          assigneeType: true,
          assigneeName: true,
          lastEventAt: true,
          lastError: true,
          lastErrorAt: true,
          inbox: { select: { id: true, name: true, agentId: true } },
          contact: { select: { name: true } },
        },
      }),
    ),
    runScopedOn(base, ctx, (db) =>
      // @ts-ignore — WhazingConversation added to schema; types regenerate at build time
      db.whazingConversation.findMany({
        where: whazingWhere,
        orderBy: [
          { lastEventAt: { sort: "desc", nulls: "last" } },
          { id: "desc" },
        ],
        take: take + 1,
        select: {
          id: true,
          ticketId: true,
          threadId: true,
          status: true,
          assignedUserId: true,
          contactName: true,
          agentId: true,
          lastEventAt: true,
          lastError: true,
          lastErrorAt: true,
          inbox: { select: { id: true, name: true } },
        },
      }),
    ).catch(() => [] as unknown[]),
  ]);

  // Normalize Whazing rows to a shared shape with a transport discriminator.
  type RawRow = {
    _type: "chatwoot" | "whazing";
    id: bigint;
    threadId: string;
    chatwootConversationId: number;
    whazingTicketId: number | null;
    status: string;
    assigneeId: number | null;
    assigneeType: string | null;
    assigneeName: string | null;
    lastEventAt: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    inboxId: bigint | null;
    inboxName: string | null;
    agentId: bigint | null;
    contactName: string | null;
  };

  const cwNorm: RawRow[] = (chatwootRows as typeof chatwootRows).map((r) => ({
    _type: "chatwoot",
    id: r.id,
    threadId: r.threadId,
    chatwootConversationId: r.chatwootConversationId,
    whazingTicketId: null,
    status: r.status,
    assigneeId: r.assigneeId,
    assigneeType: r.assigneeType,
    assigneeName: r.assigneeName,
    lastEventAt: r.lastEventAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    inboxId: r.inbox?.id ?? null,
    inboxName: r.inbox?.name ?? null,
    agentId: r.inbox?.agentId ?? null,
    contactName: r.contact?.name ?? null,
  }));

  const wzNorm: RawRow[] = (whazingRows as Array<Record<string, unknown>>).map((r) => ({
    _type: "whazing",
    id: r.id as bigint,
    threadId: r.threadId as string,
    chatwootConversationId: 0,
    whazingTicketId: r.ticketId as number,
    status: r.status as string,
    assigneeId: (r.assignedUserId as number | null) ?? null,
    assigneeType: null,
    assigneeName: null,
    lastEventAt: (r.lastEventAt as Date | null) ?? null,
    lastError: (r.lastError as string | null) ?? null,
    lastErrorAt: (r.lastErrorAt as Date | null) ?? null,
    inboxId: (r.inbox as { id: bigint } | null)?.id ?? null,
    inboxName: (r.inbox as { name: string } | null)?.name ?? null,
    agentId: (r.agentId as bigint | null) ?? null,
    contactName: (r.contactName as string | null) ?? null,
  }));

  // Merge and sort: lastEventAt DESC nulls-last, then id DESC (arbitrary tie-break across transports).
  const merged = [...cwNorm, ...wzNorm].sort((a, b) => {
    const ta = a.lastEventAt?.getTime() ?? -1;
    const tb = b.lastEventAt?.getTime() ?? -1;
    if (tb !== ta) return tb - ta;
    // Tie-break: compare as string to produce a stable, consistent ordering across types
    const sa = `${a._type}:${String(a.id)}`;
    const sb = `${b._type}:${String(b.id)}`;
    return sb < sa ? -1 : sb > sa ? 1 : 0;
  });

  const hasMore = merged.length > take;
  const pageRows = merged.slice(0, take);

  // Resolve the bound persona names + out-of-hours for this page in batched reads.
  const agentIds = [
    ...new Set(pageRows.map((r) => r.agentId).filter((x): x is bigint => x != null)),
  ];
  const agentNameById = new Map<string, string>();
  const agentHoursId = new Map<string, bigint | null>();
  if (agentIds.length > 0) {
    const agents = await runScopedOn(base, ctx, (db) =>
      db.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, name: true, businessHoursId: true },
      }),
    );
    for (const a of agents) {
      agentNameById.set(String(a.id), a.name);
      agentHoursId.set(String(a.id), a.businessHoursId);
    }
  }
  const outOfHoursByHoursId = new Map<string, boolean>();
  const hoursIds = [
    ...new Set(
      [...agentHoursId.values()].filter((h): h is bigint => h != null),
    ),
  ];
  if (hoursIds.length > 0) {
    const hoursRows = await runScopedOn(base, ctx, (db) =>
      db.businessHours.findMany({
        where: { id: { in: hoursIds } },
        select: { id: true, windows: true, timezone: true },
      }),
    );
    const now = new Date();
    for (const h of hoursRows) {
      outOfHoursByHoursId.set(
        String(h.id),
        isOutOfHoursNow(parseWindows(h.windows), h.timezone, now),
      );
    }
  }
  const agentOutOfHours = (agentId: bigint | null | undefined): boolean => {
    if (agentId == null) return false;
    const hId = agentHoursId.get(String(agentId));
    return hId != null ? (outOfHoursByHoursId.get(String(hId)) ?? false) : false;
  };

  const items: ConversationListItem[] = pageRows.map((r) => ({
    id: r._type === "chatwoot" ? `c_${String(r.id)}` : `w_${String(r.id)}`,
    transport: r._type,
    threadId: r.threadId,
    chatwootConversationId: r.chatwootConversationId,
    whazingTicketId: r.whazingTicketId,
    status: r.status,
    assigneeId: r.assigneeId,
    assigneeType: r.assigneeType,
    assigneeName: r.assigneeName,
    lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt ? r.lastErrorAt.toISOString() : null,
    inbox:
      r.inboxId != null && r.inboxName != null
        ? { id: String(r.inboxId), name: r.inboxName }
        : null,
    contact: r.contactName != null ? { name: r.contactName } : null,
    agentName: r.agentId != null ? (agentNameById.get(String(r.agentId)) ?? null) : null,
    outOfHours: agentOutOfHours(r.agentId),
  }));

  // Next cursor encodes the lastEventAt of the last item so the next page starts after it.
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? `t:${lastItem.lastEventAt ? new Date(lastItem.lastEventAt).getTime() : 0}`
      : null;

  return { items, nextCursor };
}

// ── operations (on-demand fetch + actions over the Chatwoot client) ──
//
// The mirror holds METADATA only; the thread is fetched on demand from Chatwoot (admin token).
// Actions (reply/handoff/return/status) go over the client (bot token) — NETWORK happens OUTSIDE
// any tx; we then optimistically update the mirror for immediate UI feedback (the webhook reconciles
// the canonical state, with its lastEventAt monotonic guard).
//
// NOTE: getConversationDetail's message normalization follows the Chatwoot message shape
// (payload[] of { id, content, message_type, private, created_at, sender }), CONFIRMED live against
// a chatwoot-pro instance (message_type is a NUMBER here, unlike the webhook where it is a string).

// A message attachment as the admin messages API serializes it (_message.json.jbuilder maps each
// via Attachment#push_event_data): file_type bucket, the (host-served) data_url, an image thumb_url,
// and, for audio, the transcription our eager STT wrote back. The thread renders audio (player +
// transcription) and images inline; data_url is proxied through our origin (getConversationMedia).
export interface ConversationAttachment {
  id: number | null;
  fileType: string | null;
  dataUrl: string | null;
  thumbUrl: string | null;
  transcribedText: string | null;
}

export interface ConversationMessage {
  id: number | null;
  content: string | null;
  messageType: number | null;
  private: boolean;
  createdAt: number | null;
  senderName: string | null;
  senderType: string | null;
  attachments: ConversationAttachment[];
  // content_attributes.in_reply_to — the quoted/replied-to message id (the console renders a quote
  // preview by resolving it against the loaded thread). null when this message is not a reply.
  inReplyTo: number | null;
  // content_attributes.is_reaction — true when this message is an emoji reaction (content = emoji).
  isReaction: boolean;
}

// Metadata shell of a conversation (a single scoped DB read, NO network) — renders the detail page
// immediately. The message thread is fetched separately (getConversationMessages) so a slow/down
// Chatwoot only affects the messages area, not the whole page.
export interface ConversationDetail {
  id: string;
  threadId: string;
  chatwootConversationId: number;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  // Human assignee display name (null when AI-handled / unassigned) — shown instead of "Human #id".
  assigneeName: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  inbox: { id: string; name: string } | null;
  // contact.voiceReply: the per-contact audio-reply preference (true=audio, false=text, null=unknown).
  contact: { name: string | null; voiceReply: boolean | null } | null;
  // The bound persona, so the console can show its name and deep-link to its editor.
  agentId: string | null;
  agentName: string | null;
  // The bound persona's operating mode (item 1), so the console can flag a test agent. null = no agent.
  agentMode: "test" | "production" | null;
  // The model the bound persona runs (e.g. "gpt-5.4-mini"), shown in the conversation header. null = no
  // agent or an unparseable model config.
  agentModel: string | null;
  // True when the bound agent's availability schedule (businessHoursId) is currently CLOSED (item 23).
  // Computed server-side ("now" in the schedule's timezone), so it never depends on the browser clock.
  // false when there's no agent or no schedule (always-on).
  outOfHours: boolean;
  // When this conversation was activated for a test agent via /teste (ISO). null = not activated.
  testActivatedAt: string | null;
  // Proactive follow-up journey, for an operator-facing indicator (item 17). null = no agent bound.
  // Times are ESTIMATES — follow-ups fire on background jobs that can be delayed.
  followUp: {
    enabled: boolean;
    totalSteps: number;
    // The next pending follow-up: 1-based step index + estimated run time (ISO). null = none pending.
    nextStep: number | null;
    nextRunAt: string | null;
    // True when nextRunAt was pushed past the configured cadence because it fell outside the send
    // window (item 3) — so the UI can explain why the ETA exceeds the step's delay.
    nextRunAtDeferred: boolean;
    // When the last follow-up fired for this conversation (ISO). null = none has fired yet.
    lastFollowUpAt: string | null;
    // The configured sequence, for the "full sequence" tooltip: per-step delay + optional label + the
    // step that resolves the conversation. Cadence: step 1 = inactivity threshold; later = wait AFTER
    // the previous step. Empty when follow-up is disabled.
    steps: {
      delayValue: number;
      delayUnit: FollowUpDelayUnit;
      assignLabels: string[];
      resolve: boolean;
    }[];
    // The schedule that gates proactive sends (follow-up-specific hours, else the agent's main hours).
    // null = no restriction (the follow-up can fire any time). Surfaced in the sequence tooltip so the
    // operator sees the allowed send window — the same windows the estimate + worker honor.
    hours: {
      timezone: string;
      windows: { day: number; start: string; end: string }[];
    } | null;
    // WhatsApp→chat redirect (channelRedirect): this conversation's inbox is the redirect's entry or
    // widget inbox, so the generic follow-up above is SUPPRESSED here (the redirect owns re-engagement
    // for those two inboxes — enforced in the followups sweep + handler). The UI shows a redirect
    // indicator instead of the — never-firing — generic estimate. false for every other conversation.
    managedByRedirect: boolean;
    // The pending REDIRECT_FOLLOWUP keyed to this conversation, when managedByRedirect. Only the WIDGET
    // conversation carries one (the entry/WhatsApp side is re-engaged by the gate re-sending the link on
    // the next inbound, not a scheduled job). null = none pending (or not the widget side).
    redirectNext: { stage: "chat" | "whatsapp"; runAt: string } | null;
  } | null;
  // Pending appointment reminders for THIS conversation (deterministic Calendar-booked reminders), for
  // an operator-facing "a reminder is scheduled" indicator. One entry per pending scheduler job, soonest
  // first; empty when none. Unlike the follow-up estimate, these run times are exact (give or take the
  // worker tick).
  appointmentReminders: {
    runAt: string; // when the reminder fires (ISO)
    startISO: string | null; // the appointment start it is for (ISO), when known
    offsetHours: number | null; // how long before the start (hours)
    isLast: boolean; // the closest reminder (the one that may ask for confirmation)
  }[];
  // Transport: "chatwoot" or "whazing". Drives conditional rendering in the detail page.
  transport: ConversationTransport;
  // Whazing-only fields (null for Chatwoot conversations).
  whazingTicketId: number | null;
  // Origin for the "Open in Whazing" link (null for Chatwoot).
  whazingBaseUrl: string | null;
  // Origin + account of the conversation's Chatwoot instance, to build an "open in Chatwoot" link
  // (${chatwootBaseUrl}/app/accounts/${accountId}/conversations/${chatwootConversationId}).
  // Both null for Whazing conversations.
  chatwootBaseUrl: string;
  accountId: number;
  // Recent execution-flow markers for THIS conversation (PII-free), interleaved into the timeline:
  // tool calls (name + status + duration) and proactive follow-up sends. Oldest → newest.
  trail: ConversationTrailEntry[];
}

// A compact, PII-free activity marker drawn inline in the conversation timeline. Derived from the
// ExecutionLog: a tool call (kind "tool"), a proactive follow-up send (kind "followup"), or an
// appointment reminder send (kind "reminder").
export interface ConversationTrailEntry {
  id: string;
  kind: "tool" | "followup" | "reminder";
  // tool → the tool's name; followup/reminder → the nudge source (e.g. "followup").
  name: string | null;
  status: string | null;
  durationMs: number | null;
  // followup → the 1-based sequence step that fired ("Follow-up N enviado"). null when not recorded.
  step: number | null;
  // tool → the (already-redacted, truncated) arguments the agent passed and the tool's result, so the
  // operator can expand the marker to inspect what ran (parity with the playground trace). Both null for
  // follow-up rows and for tool rows logged before this field existed. args is a JSON value; output is a
  // string (the result text the model saw).
  args: unknown;
  output: string | null;
  // tool → the sanitized error message when the tool FAILED (status "error"), so the operator sees WHY
  // it failed inline instead of just a ✗. null on success and for follow-up/reminder rows.
  errorMessage: string | null;
  at: string;
}

export interface ConversationThread {
  messages: ConversationMessage[];
  // True when the live thread fetch from Chatwoot failed (timeout/unreachable/error) — the UI shows
  // a retry in the messages area instead of breaking the page.
  messagesUnavailable: boolean;
  // True when the fetched page was FULL (the fork returns ~20 per page), so older messages likely
  // exist before it — the console shows "load older" only then (item 4). A partial page ⇒ start of
  // history ⇒ button hidden. false on a fetch failure.
  hasMoreOlder: boolean;
}

// The fork's MessageFinder page size: a full page is the signal that older history may exist.
const MESSAGES_PAGE_SIZE = 20;

// Count the raw messages in a getMessages response ({ payload: [...] } or a bare array) — the page
// size before normalizeMessages slices/drops, so it reflects whether the fork returned a full page.
function rawMessageCount(raw: unknown): number {
  const payload = (raw as { payload?: unknown } | null)?.payload;
  if (Array.isArray(payload)) return payload.length;
  return Array.isArray(raw) ? (raw as unknown[]).length : 0;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeMessages(raw: unknown): ConversationMessage[] {
  const payload = (raw as { payload?: unknown } | null)?.payload;
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return arr.slice(-100).map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    const sender = (msg.sender ?? {}) as Record<string, unknown>;
    const ca =
      typeof msg.content_attributes === "object" && msg.content_attributes
        ? (msg.content_attributes as Record<string, unknown>)
        : null;
    const inReplyTo =
      ca && typeof ca.in_reply_to === "number" ? ca.in_reply_to : null;
    const attachments: ConversationAttachment[] = Array.isArray(msg.attachments)
      ? (msg.attachments as unknown[])
          .filter(
            (a): a is Record<string, unknown> =>
              typeof a === "object" && a !== null,
          )
          .map((a) => ({
            id: typeof a.id === "number" ? a.id : null,
            fileType: asStr(a.file_type),
            dataUrl: asStr(a.data_url),
            thumbUrl: asStr(a.thumb_url),
            // Empty string (the fork's default when un-transcribed) normalizes to null.
            transcribedText: asStr(a.transcribed_text) || null,
          }))
      : [];
    return {
      id: typeof msg.id === "number" ? msg.id : null,
      content: asStr(msg.content),
      messageType:
        typeof msg.message_type === "number" ? msg.message_type : null,
      private: Boolean(msg.private),
      createdAt: typeof msg.created_at === "number" ? msg.created_at : null,
      senderName: asStr(sender.name),
      senderType: asStr(sender.type),
      attachments,
      inReplyTo,
      isReaction: ca?.is_reaction === true,
    };
  });
}

function requireTenant(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) {
    throw new AppError("tenant required", 400, "errors.tenantTargetRequired");
  }
  return ctx.tenantId;
}

async function loadConvRef(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
): Promise<{
  id: bigint;
  chatwootInstanceId: bigint;
  chatwootConversationId: number;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  assigneeName: string | null;
  threadId: string;
  lastEventAt: Date | null;
  lastInboundAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  testActivatedAt: Date | null;
  lastFollowUpAt: Date | null;
  inbox: {
    id: bigint;
    name: string;
    agentId: bigint | null;
    chatwootInboxId: number;
  } | null;
  contact: { name: string | null; voiceReply: boolean | null } | null;
  instance: { accountId: number; deployment: { baseUrl: string } };
}> {
  const conv = await runScopedOn(base, ctx, (db) =>
    db.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        chatwootInstanceId: true,
        chatwootConversationId: true,
        status: true,
        assigneeId: true,
        assigneeType: true,
        assigneeName: true,
        threadId: true,
        lastEventAt: true,
        lastInboundAt: true,
        lastError: true,
        lastErrorAt: true,
        testActivatedAt: true,
        lastFollowUpAt: true,
        inbox: {
          select: {
            id: true,
            name: true,
            agentId: true,
            chatwootInboxId: true,
          },
        },
        contact: { select: { name: true, voiceReply: true } },
        instance: {
          select: {
            accountId: true,
            deployment: { select: { baseUrl: true } },
          },
        },
      },
    }),
  );
  if (!conv) {
    throw new NotFoundError(
      "conversation not found",
      "errors.conversationNotFound",
    );
  }
  return conv;
}

// The persona bot token the console acts AS for a conversation = the bot of the inbox's bound agent.
// undefined when the inbox has no agent bound (the bot-token actions below then have no identity to
// act as — an edge case: console actions normally target bot-handled conversations).
async function convBotToken(
  tenantId: bigint,
  conv: {
    chatwootInstanceId: bigint;
    inbox: { agentId: bigint | null } | null;
  },
  base: PrismaClient,
): Promise<string | undefined> {
  const agentId = conv.inbox?.agentId;
  if (agentId == null) return undefined;
  const bot = await loadAgentBot(
    tenantId,
    conv.chatwootInstanceId,
    agentId,
    base,
  );
  return bot?.accessToken;
}

async function updateMirror(
  ctx: TenantContext,
  base: PrismaClient,
  id: bigint,
  data: {
    status?: string;
    assigneeId?: number | null;
    assigneeType?: string | null;
  },
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    db.conversation.updateMany({ where: { id }, data }),
  );
}

// Metadata only — fast scoped DB read, NO network. The UI renders the shell from this immediately.
export async function getConversationDetail(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationDetail> {
  requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Resolve the bound persona's name (separate read — Inbox carries only agentId, no relation).
  const agentId = conv.inbox?.agentId ?? null;
  const agent =
    agentId != null
      ? await runScopedOn(base, ctx, (db) =>
          db.agent.findUnique({
            where: { id: agentId },
            select: {
              name: true,
              mode: true,
              settings: true,
              modelConfig: true,
              businessHoursId: true,
              followUpHoursId: true,
            },
          }),
        )
      : null;

  // Follow-up journey (item 17): the agent's configured step count + the next PENDING follow-up job
  // for this conversation's thread. The job's runAt is an ESTIMATE — it fires on a background worker.
  let followUp: ConversationDetail["followUp"] = null;
  if (agentId != null) {
    const cfg = readFollowUpConfig(agent?.settings);
    // WhatsApp→chat redirect: when this conversation's inbox is the redirect's entry or widget inbox,
    // the generic follow-up is suppressed for it (the redirect owns re-engagement — see the followups
    // sweep + handler). Detect it so the estimate below is skipped and the UI shows the redirect
    // indicator instead of an estimate that can never fire.
    const redirectCfg = readChannelRedirectConfig(agent?.settings);
    const inboxCwId = conv.inbox?.chatwootInboxId ?? null;
    const managedByRedirect =
      redirectCfg.enabled &&
      inboxCwId != null &&
      (redirectCfg.widgetInboxId === inboxCwId ||
        redirectCfg.entryInboxId === inboxCwId);
    const isRedirectWidgetConv =
      redirectCfg.enabled &&
      inboxCwId != null &&
      redirectCfg.widgetInboxId === inboxCwId;
    // The schedule gating proactive sends (follow-up-specific hours, else the agent's main hours).
    // Fetched once: used to adjust the estimate AND surfaced in the UI tooltip — both must match what
    // the worker honors. null/empty → no restriction (the follow-up can fire any time).
    const hoursId = agent?.followUpHoursId ?? agent?.businessHoursId ?? null;
    const hoursRow =
      cfg.enabled && !managedByRedirect && hoursId != null
        ? await runScopedOn(base, ctx, (db) =>
            db.businessHours.findUnique({
              where: { id: hoursId },
              select: { windows: true, timezone: true },
            }),
          )
        : null;
    const hoursWindows = hoursRow ? parseWindows(hoursRow.windows) : [];
    const job = managedByRedirect
      ? null
      : await runScopedOn(base, ctx, (db) =>
          db.schedulerJob.findFirst({
            where: {
              kind: "FOLLOWUP",
              dedupeKey: `followup:${conv.threadId}`,
              status: "PENDING",
            },
            select: { runAt: true, payload: true },
          }),
        );
    let nextStep: number | null = null;
    let nextRunAt: string | null = null;
    // True when the configured cadence landed outside the send window, so the estimate was pushed to
    // the next open slot (item 3): the conversation line then reads e.g. "in 3 days" even though the
    // step is "2d". The tooltip uses this to explain the deferral.
    let nextRunAtDeferred = false;
    const firstStep = cfg.steps[0];
    if (job) {
      const rawStep = (job.payload as { stepIndex?: unknown } | null)
        ?.stepIndex;
      const stepIndex = typeof rawStep === "number" ? rawStep : 0;
      nextStep = stepIndex + 1;
      // job.runAt is NOT the firing time yet — the sweep enqueues step 0 with runAt=now (and re-arms
      // it on EVERY pass), so a freshly-swept job's runAt sits before the real cadence AND outside the
      // business-hours window until the worker claims it and reschedules. Reconstruct what will actually
      // fire, exactly like the handler: floor step 0 at lastEventAt + first-step delay, then push an
      // out-of-window time to the next open window. Without this the indicator flickers to "imminent /
      // out-of-hours" right after each sweep and only resyncs once the worker rewrites run_at.
      let dueAt = job.runAt;
      if (stepIndex === 0 && firstStep && conv.lastEventAt) {
        const floor = new Date(
          conv.lastEventAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
        );
        if (floor.getTime() > dueAt.getTime()) dueAt = floor;
      }
      const ungated = dueAt.getTime();
      if (hoursRow && hoursWindows.length > 0) {
        dueAt = nextOpenAt(hoursWindows, hoursRow.timezone, dueAt) ?? dueAt;
      }
      if (dueAt.getTime() > ungated) nextRunAtDeferred = true;
      nextRunAt = dueAt.toISOString();
    } else if (
      // No job armed yet: estimate the FIRST step so the operator sees a live countdown during the
      // idle window. The sweep only enqueues the job ~at fire time, so for short delays (e.g. 1 min)
      // the pending-job window is seconds — without this estimate the indicator would sit at "none
      // scheduled" the whole time, then jump straight to "complete". Same eligibility as the sweep:
      // follow-up on, a fresh episode (none fired yet, OR the customer replied since the last one — a
      // reply restarts the sequence at step 0), the bot still owns the conversation, the agent isn't
      // test-silenced, and we know when the conversation last moved. The episode predicate MUST match
      // the sweep/handler (isNewFollowUpEpisode) or the indicator disagrees with what actually fires.
      // (managedByRedirect already forces job=null; guard the estimate too so it stays suppressed.)
      !managedByRedirect &&
      cfg.enabled &&
      firstStep &&
      isNewFollowUpEpisode(conv.lastFollowUpAt, conv.lastInboundAt) &&
      conv.lastEventAt &&
      shouldBotHandle({
        status: conv.status,
        assigneeType: conv.assigneeType,
      }) &&
      !isTestSilenced(agent?.mode ?? "production", conv.testActivatedAt)
    ) {
      nextStep = 1;
      let dueAt = new Date(
        conv.lastEventAt.getTime() + stepDelayMinutes(firstStep) * 60_000,
      );
      const ungated = dueAt.getTime();
      // Mirror the handler's business-hours gate: a follow-up coming due outside the configured window
      // does NOT fire then — the worker reschedules it into the next open window. Reflect that here so
      // the estimate never shows a time the follow-up can't actually fire.
      if (hoursRow && hoursWindows.length > 0) {
        dueAt = nextOpenAt(hoursWindows, hoursRow.timezone, dueAt) ?? dueAt;
      }
      if (dueAt.getTime() > ungated) nextRunAtDeferred = true;
      nextRunAt = dueAt.toISOString();
    }
    // The pending redirect follow-up, keyed to the WIDGET conversation's thread (the entry/WhatsApp
    // side has no job of its own). Surfaced in place of the — suppressed — generic estimate.
    let redirectNext: { stage: "chat" | "whatsapp"; runAt: string } | null =
      null;
    if (isRedirectWidgetConv) {
      const rj = await runScopedOn(base, ctx, (db) =>
        db.schedulerJob.findFirst({
          where: {
            kind: "REDIRECT_FOLLOWUP",
            dedupeKey: `redirect-followup:${conv.threadId}`,
            status: "PENDING",
          },
          select: { runAt: true, payload: true },
        }),
      );
      if (rj) {
        const stage =
          (rj.payload as { stage?: unknown } | null)?.stage === "whatsapp"
            ? "whatsapp"
            : "chat";
        redirectNext = { stage, runAt: rj.runAt.toISOString() };
      }
    }
    followUp = {
      enabled: cfg.enabled,
      totalSteps: cfg.steps.length,
      nextStep,
      nextRunAt,
      nextRunAtDeferred,
      lastFollowUpAt: conv.lastFollowUpAt
        ? conv.lastFollowUpAt.toISOString()
        : null,
      steps: cfg.enabled
        ? cfg.steps.map((s) => ({
            delayValue: s.delayValue,
            delayUnit: s.delayUnit,
            assignLabels: s.assignLabels ?? [],
            resolve: s.resolve === true,
          }))
        : [],
      hours:
        hoursRow && hoursWindows.length > 0
          ? { timezone: hoursRow.timezone, windows: hoursWindows }
          : null,
      managedByRedirect,
      redirectNext,
    };
  }

  // Out-of-hours status (item 23): the AGENT's availability schedule (businessHoursId, NOT the
  // follow-up schedule), evaluated at "now" in its own timezone. Surfaced as a header badge.
  let outOfHours = false;
  if (agent?.businessHoursId != null) {
    const availId = agent.businessHoursId;
    const bh = await runScopedOn(base, ctx, (db) =>
      db.businessHours.findUnique({
        where: { id: availId },
        select: { windows: true, timezone: true },
      }),
    );
    if (bh) {
      outOfHours = isOutOfHoursNow(
        parseWindows(bh.windows),
        bh.timezone,
        new Date(),
      );
    }
  }

  // Activity trail (item 8 + 12): recent tool calls + proactive follow-up sends for this conversation,
  // from the execution-flow log (real traffic only, PII-free). One indexed read; the UI interleaves
  // these markers into the message timeline by timestamp. A generate row counts as a follow-up marker
  // only when it carries detail.trigger (the nudge source) — ordinary turns are excluded.
  const trailRows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where: {
        conversationId: id,
        source: "inbox",
        stage: { in: ["tool", "generate"] },
      },
      orderBy: { id: "desc" },
      take: 60,
      select: {
        id: true,
        stage: true,
        status: true,
        durationMs: true,
        detail: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  );
  const trail: ConversationTrailEntry[] = [];
  for (const r of trailRows) {
    const detail = (r.detail ?? null) as Record<string, unknown> | null;
    if (r.stage === "tool") {
      const rawOutput = detail?.output;
      trail.push({
        id: String(r.id),
        kind: "tool",
        name: typeof detail?.tool === "string" ? detail.tool : null,
        status: r.status,
        durationMs: r.durationMs,
        step: null,
        args: detail?.args ?? null,
        output:
          typeof rawOutput === "string"
            ? rawOutput
            : rawOutput != null
              ? JSON.stringify(rawOutput)
              : null,
        errorMessage: r.status === "error" ? r.errorMessage : null,
        at: r.createdAt.toISOString(),
      });
    } else if (
      r.stage === "generate" &&
      detail &&
      typeof detail.trigger === "string"
    ) {
      trail.push({
        id: String(r.id),
        kind:
          detail.trigger === "appointment_reminder" ? "reminder" : "followup",
        name: detail.trigger,
        status: r.status,
        durationMs: r.durationMs,
        step: typeof detail.step === "number" ? detail.step : null,
        args: null,
        output: null,
        errorMessage: null,
        at: r.createdAt.toISOString(),
      });
    }
  }
  // Rows came newest-first (id desc); the timeline wants oldest → newest.
  trail.reverse();

  // Pending appointment reminders for this conversation's thread (soonest first). Exact times — these
  // are armed scheduler jobs, not estimates. Read under the same tenant scope as the trail.
  const reminderRows = await runScopedOn(base, ctx, (db) =>
    db.schedulerJob.findMany({
      where: {
        kind: "APPOINTMENT_REMINDER",
        status: "PENDING",
        payload: { path: ["threadId"], equals: conv.threadId },
      },
      orderBy: { runAt: "asc" },
      take: 20,
      select: { runAt: true, payload: true },
    }),
  );
  const appointmentReminders = reminderRows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return {
      runAt: r.runAt.toISOString(),
      startISO: typeof p.startISO === "string" ? p.startISO : null,
      offsetHours: typeof p.offsetHours === "number" ? p.offsetHours : null,
      isLast: p.isLast === true,
    };
  });

  return {
    id: String(conv.id),
    threadId: conv.threadId,
    chatwootConversationId: conv.chatwootConversationId,
    status: conv.status,
    assigneeId: conv.assigneeId,
    assigneeType: conv.assigneeType,
    assigneeName: conv.assigneeName,
    lastError: conv.lastError,
    lastErrorAt: conv.lastErrorAt ? conv.lastErrorAt.toISOString() : null,
    inbox: conv.inbox
      ? { id: String(conv.inbox.id), name: conv.inbox.name }
      : null,
    contact: conv.contact
      ? { name: conv.contact.name, voiceReply: conv.contact.voiceReply }
      : null,
    agentId: agentId != null ? String(agentId) : null,
    agentName: agent?.name ?? null,
    agentMode: agent ? (agent.mode === "test" ? "test" : "production") : null,
    agentModel: (() => {
      const parsed = modelConfigSchema.safeParse(agent?.modelConfig);
      return parsed.success ? parsed.data.model : null;
    })(),
    outOfHours,
    testActivatedAt: conv.testActivatedAt
      ? conv.testActivatedAt.toISOString()
      : null,
    followUp,
    appointmentReminders,
    transport: "chatwoot" as ConversationTransport,
    whazingTicketId: null,
    whazingBaseUrl: null,
    chatwootBaseUrl: conv.instance.deployment.baseUrl,
    accountId: conv.instance.accountId,
    trail,
  };
}

// The live message thread (network: Chatwoot admin token), fetched on its own so a slow/unreachable
// instance only spins the messages area, not the whole page. Degrades gracefully: on failure returns
// an empty thread with messagesUnavailable=true (the UI shows a retry) instead of throwing a 500.
export async function getConversationMessages(
  ctx: TenantContext,
  id: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
  // When set, page backwards: return the messages OLDER than this Chatwoot message id (the console's
  // "load older" on scroll-up). Omitted → the most recent page.
  before?: number,
): Promise<ConversationThread> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  try {
    const raw = await client.getMessages(
      conv.chatwootConversationId,
      before != null ? { before } : undefined,
    );
    return {
      messages: normalizeMessages(raw),
      messagesUnavailable: false,
      hasMoreOlder: rawMessageCount(raw) >= MESSAGES_PAGE_SIZE,
    };
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conv.id) },
      "chatwoot getMessages failed; serving conversation without the thread",
    );
    return { messages: [], messagesUnavailable: true, hasMoreOlder: false };
  }
}

export interface ConversationMediaBlob {
  bytes: ArrayBuffer;
  contentType: string;
}

// Proxies a conversation attachment (voice note / image / file) from the tenant's Chatwoot through
// OUR origin. Same-origin delivery is required: CSP pins media-src/img-src to 'self'/blob:, and the
// SUPER_ADMIN tenant selector rides only on our API calls (a raw cross-origin Chatwoot URL would trip
// CSP). Security: the url MUST be on the conversation's own instance origin (so we are never an open
// proxy to arbitrary hosts), and downloadAttachment re-applies anti-SSRF + sends the admin token only
// when the host matches. Returns null when the instance row is gone.
export async function getConversationMedia(
  ctx: TenantContext,
  id: bigint,
  url: string,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ConversationMediaBlob | null> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const instance = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({
      where: { id: conv.chatwootInstanceId },
      select: { deployment: { select: { baseUrl: true } } },
    }),
  );
  if (!instance) return null;
  let sameOrigin = false;
  try {
    sameOrigin =
      new URL(url).origin === new URL(instance.deployment.baseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    throw new AppError("media url is not on the conversation's instance", 400);
  }
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  const { bytes, contentType } = await client.downloadAttachment(url);
  return {
    bytes,
    contentType: contentType ?? "application/octet-stream",
  };
}

export async function replyToConversation(
  ctx: TenantContext,
  id: bigint,
  content: string,
  isPrivate: boolean,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
    botToken: await convBotToken(tenantId, conv, base),
  });
  await client.sendMessage(conv.chatwootConversationId, content, {
    private: isPrivate,
  });
}

// Handoff: optionally assign a specific human, then set status open so the attribution gate stops
// the bot. assigneeId is the Chatwoot agent id.
export async function handoffConversation(
  ctx: TenantContext,
  id: bigint,
  assigneeId: number | null,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → use the instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  if (assigneeId !== null) {
    await client.assignToAgent(conv.chatwootConversationId, assigneeId, {
      asAdmin: true,
    });
  }
  await client.toggleStatus(conv.chatwootConversationId, "open", {
    asAdmin: true,
  });
  await updateMirror(ctx, base, id, {
    status: "open",
    assigneeType: "User",
    ...(assigneeId !== null ? { assigneeId } : {}),
  });
  // Optimistic realtime feedback (the inbound webhook reconciles canonically).
  broadcastConversationEvent(tenantId, {
    conversationId: `c_${String(id)}`,
    status: "open",
    assigneeId: assigneeId ?? conv.assigneeId,
    assigneeType: "User",
    lastEventAt: conv.lastEventAt ? conv.lastEventAt.toISOString() : null,
  });
}

// Return to the bot: set status pending AND unassign the human (the gate requires BOTH
// status === "pending" and assignee_type !== "User"). A live probe against the chatwoot-pro fork
// confirmed that toggle_status → pending does NOT clear the assignee, so unassigning is mandatory —
// otherwise the next inbound message still carries assignee_type "User" and the bot stays silent.
// The optional reengage prompt is a separate proactive message the caller sends via replyToConversation.
export async function returnConversationToAgent(
  ctx: TenantContext,
  id: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  await client.unassignConversation(conv.chatwootConversationId, {
    asAdmin: true,
  });
  await client.toggleStatus(conv.chatwootConversationId, "pending", {
    asAdmin: true,
  });
  await updateMirror(ctx, base, id, {
    status: "pending",
    assigneeId: null,
    assigneeType: null,
  });
  broadcastConversationEvent(tenantId, {
    conversationId: `c_${String(id)}`,
    status: "pending",
    assigneeId: null,
    assigneeType: null,
    lastEventAt: conv.lastEventAt ? conv.lastEventAt.toISOString() : null,
  });
}

export async function setConversationStatus(
  ctx: TenantContext,
  id: bigint,
  status: "open" | "pending" | "resolved",
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenantId = requireTenant(ctx);
  const conv = await loadConvRef(ctx, id, base);
  // Operator-initiated → instance admin token (audit shows the operator, not the persona).
  const client = await loadChatwootClient(tenantId, conv.chatwootInstanceId, {
    ...deps,
    base,
  });
  await client.toggleStatus(conv.chatwootConversationId, status, {
    asAdmin: true,
  });
  await updateMirror(ctx, base, id, { status });
  broadcastConversationEvent(tenantId, {
    conversationId: `c_${String(id)}`,
    status,
    assigneeId: conv.assigneeId,
    assigneeType: conv.assigneeType,
    lastEventAt: conv.lastEventAt ? conv.lastEventAt.toISOString() : null,
  });
}

// ── Whazing conversation operations ──
//
// WhazingConversation rows are metadata mirrors (no PII beyond contactName). Messages are fetched
// on demand from the Whazing External API (GET /ticket/:id). Write operations are not supported
// in the operator console MVP — the detail page is read-only for Whazing conversations.

async function loadWhazingConvRef(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
): Promise<{
  id: bigint;
  ticketId: number;
  threadId: string;
  status: string;
  assignedUserId: number | null;
  contactName: string | null;
  agentId: bigint | null;
  instanceId: bigint;
  lastEventAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  inbox: { id: bigint; name: string } | null;
  instance: { baseUrl: string };
}> {
  const row = await runScopedOn(base, ctx, (db) =>
    // @ts-ignore — WhazingConversation types regenerate at build time
    db.whazingConversation.findUnique({
      where: { id },
      select: {
        id: true,
        ticketId: true,
        threadId: true,
        status: true,
        assignedUserId: true,
        contactName: true,
        agentId: true,
        instanceId: true,
        lastEventAt: true,
        lastError: true,
        lastErrorAt: true,
        inbox: { select: { id: true, name: true } },
        instance: { select: { baseUrl: true } },
      },
    }),
  );
  if (!row) {
    throw new NotFoundError("conversation not found", "errors.conversationNotFound");
  }
  return row as {
    id: bigint;
    ticketId: number;
    threadId: string;
    status: string;
    assignedUserId: number | null;
    contactName: string | null;
    agentId: bigint | null;
    instanceId: bigint;
    lastEventAt: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    inbox: { id: bigint; name: string } | null;
    instance: { baseUrl: string };
  };
}

// Metadata-only detail for a Whazing conversation. Mirrors getConversationDetail in shape
// but omits Chatwoot-specific fields (followUp, appointmentReminders, voiceReply, etc.).
export async function getWhazingConversationDetail(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationDetail> {
  requireTenant(ctx);
  const conv = await loadWhazingConvRef(ctx, id, base);
  const agentId = conv.agentId;
  const agent =
    agentId != null
      ? await runScopedOn(base, ctx, (db) =>
          db.agent.findUnique({
            where: { id: agentId },
            select: { name: true, mode: true, modelConfig: true, businessHoursId: true },
          }),
        )
      : null;

  let outOfHours = false;
  if (agent?.businessHoursId != null) {
    const bh = await runScopedOn(base, ctx, (db) =>
      db.businessHours.findUnique({
        where: { id: agent.businessHoursId! },
        select: { windows: true, timezone: true },
      }),
    );
    if (bh) {
      outOfHours = isOutOfHoursNow(parseWindows(bh.windows), bh.timezone, new Date());
    }
  }

  // Trail: same as Chatwoot — ExecutionLog.conversationId is set to the WhazingConversation row id
  // by the upsert in runtime.ts, so tool calls appear here automatically.
  const trailRows = await runScopedOn(base, ctx, (db) =>
    db.executionLog.findMany({
      where: {
        conversationId: id,
        source: "inbox",
        stage: { in: ["tool", "generate"] },
      },
      orderBy: { id: "desc" },
      take: 60,
      select: {
        id: true,
        stage: true,
        status: true,
        durationMs: true,
        detail: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  );
  const trail: ConversationTrailEntry[] = [];
  for (const r of trailRows) {
    const detail = (r.detail ?? null) as Record<string, unknown> | null;
    if (r.stage === "tool") {
      const rawOutput = detail?.output;
      trail.push({
        id: String(r.id),
        kind: "tool",
        name: typeof detail?.tool === "string" ? detail.tool : null,
        status: r.status,
        durationMs: r.durationMs,
        step: null,
        args: detail?.args ?? null,
        output:
          typeof rawOutput === "string"
            ? rawOutput
            : rawOutput != null
              ? JSON.stringify(rawOutput)
              : null,
        errorMessage: r.status === "error" ? r.errorMessage : null,
        at: r.createdAt.toISOString(),
      });
    } else if (r.stage === "generate" && detail && typeof detail.trigger === "string") {
      trail.push({
        id: String(r.id),
        kind: detail.trigger === "appointment_reminder" ? "reminder" : "followup",
        name: detail.trigger,
        status: r.status,
        durationMs: r.durationMs,
        step: typeof detail.step === "number" ? detail.step : null,
        args: null,
        output: null,
        errorMessage: null,
        at: r.createdAt.toISOString(),
      });
    }
  }
  trail.reverse();

  return {
    id: `w_${String(conv.id)}`,
    threadId: conv.threadId,
    chatwootConversationId: 0,
    status: conv.status,
    assigneeId: conv.assignedUserId,
    assigneeType: null,
    assigneeName: null,
    lastError: conv.lastError,
    lastErrorAt: conv.lastErrorAt ? conv.lastErrorAt.toISOString() : null,
    inbox: conv.inbox ? { id: String(conv.inbox.id), name: conv.inbox.name } : null,
    contact: conv.contactName != null ? { name: conv.contactName, voiceReply: null } : null,
    agentId: agentId != null ? String(agentId) : null,
    agentName: agent?.name ?? null,
    agentMode: agent ? (agent.mode === "test" ? "test" : "production") : null,
    agentModel: (() => {
      const parsed = modelConfigSchema.safeParse(agent?.modelConfig);
      return parsed.success ? parsed.data.model : null;
    })(),
    outOfHours,
    testActivatedAt: null,
    followUp: null,
    appointmentReminders: [],
    transport: "whazing",
    whazingTicketId: conv.ticketId,
    whazingBaseUrl: conv.instance.baseUrl,
    chatwootBaseUrl: "",
    accountId: 0,
    trail,
  };
}

// Normalize a raw Whazing ticket message to the shared ConversationMessage shape.
// The getTicket response shape is tentative; this normalizer is defensive.
function normalizeWhazingTicketMessages(raw: unknown): ConversationMessage[] {
  // Expected shapes: { messages: [...] } or a bare array
  const payload = (raw as { messages?: unknown } | null)?.messages;
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return arr.slice(-100).map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    const fromMe = msg.fromMe === true || msg.fromMe === "true";
    // Whazing: fromMe=true → we sent it (outgoing=1), fromMe=false → customer (incoming=0)
    const messageType = fromMe ? 1 : 0;
    const timestamp =
      typeof msg.timestamp === "number"
        ? msg.timestamp
        : typeof msg.createdAt === "number"
          ? msg.createdAt
          : null;
    const body =
      typeof msg.body === "string" && msg.body
        ? msg.body
        : typeof msg.text === "string" && msg.text
          ? msg.text
          : null;
    const rawAtts = Array.isArray(msg.attachments) ? msg.attachments : [];
    const attachments: ConversationAttachment[] = (rawAtts as unknown[])
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => ({
        id: typeof a.id === "number" ? a.id : null,
        fileType: typeof a.mediaType === "string" ? a.mediaType : (typeof a.type === "string" ? a.type : null),
        dataUrl: typeof a.mediaUrl === "string" ? a.mediaUrl : (typeof a.url === "string" ? a.url : null),
        thumbUrl: null,
        transcribedText: null,
      }));
    return {
      id: typeof msg.id === "number" ? msg.id : null,
      content: body,
      messageType,
      private: false,
      createdAt: timestamp,
      senderName: null,
      senderType: fromMe ? "agent_bot" : "contact",
      attachments,
      inReplyTo: null,
      isReaction: false,
    };
  });
}

// Fetch the live message thread for a Whazing conversation (GET /ticket/:id on the Whazing API).
// Degrades gracefully: on failure returns an empty thread with messagesUnavailable=true.
// NOTE: Whazing's getTicket does not support pagination — always returns the full history.
export async function getWhazingConversationMessages(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ConversationThread> {
  const tenantId = requireTenant(ctx);
  const conv = await loadWhazingConvRef(ctx, id, base);
  try {
    const client = await loadWhazingClient(tenantId, conv.instanceId, base);
    const raw = await client.getTicket(conv.ticketId);
    return {
      messages: normalizeWhazingTicketMessages(raw),
      messagesUnavailable: false,
      hasMoreOlder: false,
    };
  } catch (err) {
    logger.warn(
      { err, whazingConversationId: String(id), ticketId: conv.ticketId },
      "whazing getTicket failed; serving conversation without the thread",
    );
    return { messages: [], messagesUnavailable: true, hasMoreOlder: false };
  }
}

// Proxies a Whazing media attachment through our origin (SSRF-validated at client construction).
// The Whazing client already has the Bearer token; we just stream the bytes through.
export async function getWhazingConversationMedia(
  ctx: TenantContext,
  id: bigint,
  url: string,
  base: PrismaClient = basePrisma,
): Promise<ConversationMediaBlob | null> {
  const tenantId = requireTenant(ctx);
  const conv = await loadWhazingConvRef(ctx, id, base);
  // SSRF: the media URL must be on the same origin as the Whazing instance.
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === new URL(conv.instance.baseUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    throw new AppError("media url is not on the conversation's Whazing instance", 400);
  }
  const client = await loadWhazingClient(tenantId, conv.instanceId, base);
  const { bytes, contentType } = await client.downloadMedia(url);
  return { bytes, contentType };
}
