import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { UsageSource } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Instance metrics for the operational dashboard. LLM tokens/calls are aggregated FROM THE LOCAL
// LlmUsage table (captured at the source in the model callback), never mirrored from Langfuse —
// so the figures are RLS-isolated, fleet-aggregable, and survive Langfuse being down/optional.
// Cost is no longer stored locally; it comes from Langfuse (see langfuse-costs.ts).
// All aggregation runs INSIDE the scoped tx (GUC active) so RLS fences it to the tenant; a raw
// query outside the tx would leak or zero out. The $extends auto-scopes writes only, so reads
// rely on RLS here — which is exactly the boundary we want.

export interface AgentUsage {
  agentId: string | null;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface InboxUsage {
  inboxId: string;
  name: string | null;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  calls: number;
}

export interface SourceUsage {
  source: string;
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface InstanceMetrics {
  llm: {
    promptTokens: number;
    completionTokens: number;
    // Cached input (a discounted SUBSET of promptTokens, not additive).
    cachedReadTokens: number;
    cacheCreationTokens: number;
    calls: number;
    byAgent: AgentUsage[];
    byInbox: InboxUsage[];
    byModel: ModelUsage[];
    // The real-vs-playground split, ALWAYS computed across every source (ignores `filter.source`)
    // so the UI can show the breakdown regardless of which segment is selected.
    bySource: SourceUsage[];
  };
  conversations: {
    total: number;
    byStatus: { status: string; count: number }[];
  };
}

export interface MetricsFilter {
  since?: Date;
  // Usage segment. Omitted → all sources ("Todos"). The dashboard defaults to "inbox" so test
  // turns don't inflate the real figures.
  source?: UsageSource;
  // IANA timezone (e.g. "America/Sao_Paulo") used to bucket the daily timeseries. Omitted/invalid
  // → UTC. Only `getTimeseries` reads it; aggregate KPIs are timezone-agnostic (absolute sums).
  tz?: string;
}

// Validate an IANA timezone before interpolating it into `AT TIME ZONE` (an unknown zone makes
// Postgres throw). Unknown/missing → "UTC". `Intl.DateTimeFormat` throws RangeError for bad zones.
export function normalizeTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export async function getInstanceMetrics(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = basePrisma,
): Promise<InstanceMetrics> {
  const sinceWhere = filter.since ? { createdAt: { gte: filter.since } } : {};
  const usageWhere = {
    ...sinceWhere,
    ...(filter.source ? { source: filter.source } : {}),
  };

  return runScopedOn(base, ctx, async (db) => {
    const sumSelect = {
      promptTokens: true,
      completionTokens: true,
      cachedReadTokens: true,
      cacheCreationTokens: true,
    } as const;

    const totals = await db.llmUsage.aggregate({
      where: usageWhere,
      _sum: sumSelect,
      _count: { _all: true },
    });

    const perAgent = await db.llmUsage.groupBy({
      by: ["agentId"],
      where: usageWhere,
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    const perInbox = await db.llmUsage.groupBy({
      by: ["inboxId"],
      where: { ...usageWhere, inboxId: { not: null } },
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    const perModel = await db.llmUsage.groupBy({
      by: ["model"],
      where: usageWhere,
      _sum: {
        promptTokens: true,
        completionTokens: true,
        cachedReadTokens: true,
      },
      _count: { _all: true },
      orderBy: { _sum: { promptTokens: "desc" } },
    });

    // The real-vs-playground split: ALWAYS across every source (only the `since` window applies),
    // so the segmented control can label each option independent of the current selection.
    const perSource = await db.llmUsage.groupBy({
      by: ["source"],
      where: sinceWhere,
      _sum: { promptTokens: true, completionTokens: true },
      _count: { _all: true },
    });

    // Resolve inbox names by id (RLS-scoped), mirroring how getKpis resolves conversations by id.
    const inboxIds = perInbox
      .map((r) => r.inboxId)
      .filter((x): x is bigint => x !== null);
    const inboxNames = new Map<string, string>();
    if (inboxIds.length > 0) {
      const inboxes = await db.inbox.findMany({
        where: { id: { in: inboxIds } },
        select: { id: true, name: true },
      });
      for (const ib of inboxes) inboxNames.set(String(ib.id), ib.name);
    }

    const chatwootByStatus = await db.conversation.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    // Whazing conversations live in a separate mirror table (no Chatwoot Conversation row is ever
    // created for them) — without this, a Whazing-only tenant's conversation count is always 0.
    const whazingByStatus = await db.whazingConversation.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const byStatusMap = new Map<string, number>();
    for (const s of chatwootByStatus) {
      byStatusMap.set(
        s.status,
        (byStatusMap.get(s.status) ?? 0) + s._count._all,
      );
    }
    for (const s of whazingByStatus) {
      byStatusMap.set(
        s.status,
        (byStatusMap.get(s.status) ?? 0) + s._count._all,
      );
    }
    const byStatus = Array.from(byStatusMap, ([status, count]) => ({
      status,
      _count: { _all: count },
    }));

    const convTotal = byStatus.reduce((acc, s) => acc + s._count._all, 0);

    return {
      llm: {
        promptTokens: totals._sum.promptTokens ?? 0,
        completionTokens: totals._sum.completionTokens ?? 0,
        cachedReadTokens: totals._sum.cachedReadTokens ?? 0,
        cacheCreationTokens: totals._sum.cacheCreationTokens ?? 0,
        calls: totals._count._all,
        byAgent: perAgent.map((a) => ({
          agentId: a.agentId === null ? null : String(a.agentId),
          promptTokens: a._sum.promptTokens ?? 0,
          completionTokens: a._sum.completionTokens ?? 0,
          calls: a._count._all,
        })),
        byInbox: perInbox.map((r) => {
          const id = String(r.inboxId);
          return {
            inboxId: id,
            name: inboxNames.get(id) ?? null,
            promptTokens: r._sum.promptTokens ?? 0,
            completionTokens: r._sum.completionTokens ?? 0,
            calls: r._count._all,
          };
        }),
        byModel: perModel.map((m) => ({
          model: m.model,
          promptTokens: m._sum.promptTokens ?? 0,
          completionTokens: m._sum.completionTokens ?? 0,
          cachedReadTokens: m._sum.cachedReadTokens ?? 0,
          calls: m._count._all,
        })),
        bySource: perSource.map((s) => ({
          source: s.source,
          promptTokens: s._sum.promptTokens ?? 0,
          completionTokens: s._sum.completionTokens ?? 0,
          calls: s._count._all,
        })),
      },
      conversations: {
        total: convTotal,
        byStatus: byStatus.map((s) => ({
          status: s.status,
          count: s._count._all,
        })),
      },
    };
  });
}

// Operational KPIs (the AI-support-agent standard: Intercom Fin / OpenAI). "Involved" = the bot
// actually ran on the conversation (it produced LlmUsage). Resolution = of those, how many were
// resolved without a human taking over (assigneeType != User). Automation = Involvement ×
// Resolution = resolved-by-bot / total. All computed from local data (LlmUsage + the Conversation
// mirror), RLS-scoped inside the tx.
export interface DashboardKpis {
  totalConversations: number;
  involved: number;
  resolvedByBot: number;
  handoff: number;
  involvementRate: number;
  resolutionRate: number;
  automationRate: number;
}

export async function getKpis(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = basePrisma,
): Promise<DashboardKpis> {
  return runScopedOn(base, ctx, async (db) => {
    const sinceFilter = filter.since
      ? { createdAt: { gte: filter.since } }
      : {};
    const totalConversations =
      (await db.conversation.count({ where: sinceFilter })) +
      (await db.whazingConversation.count({ where: sinceFilter }));
    const involvedRows = await db.llmUsage.findMany({
      where: {
        // KPIs are always about real customer conversations: playground turns never create a
        // mirror conversation (conversationId stays null), and source="inbox" makes that explicit.
        conversationId: { not: null },
        source: "inbox",
        ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
      },
      select: { conversationId: true, threadId: true },
      distinct: ["conversationId"],
    });
    // conversationId is a soft (non-FK) reference into EITHER Conversation (Chatwoot) or
    // WhazingConversation — both are independent autoincrement id spaces, so a numeric id alone
    // can't tell them apart (id 21 plausibly exists in both tables). Every Whazing thread id is
    // built by resolveWhazingGraphThreadId as "tenant:<id>:whazing:...", which Chatwoot's plain
    // "<tenantId>:<instanceId>:<conversationId>" never produces — using that prefix to split the
    // id list is the same disambiguation buildConversationsWhere/parseConvId use for the
    // Conversations list page, just keyed off the thread id instead of a w_/c_ string prefix.
    const chatwootInvolvedIds: bigint[] = [];
    const whazingInvolvedIds: bigint[] = [];
    for (const r of involvedRows) {
      if (r.conversationId == null) continue;
      const isWhazing = r.threadId?.startsWith(
        `tenant:${ctx.tenantId}:whazing:`,
      );
      (isWhazing ? whazingInvolvedIds : chatwootInvolvedIds).push(
        r.conversationId,
      );
    }
    const involved = chatwootInvolvedIds.length + whazingInvolvedIds.length;
    let resolvedByBot = 0;
    let handoff = 0;
    if (chatwootInvolvedIds.length > 0) {
      const convs = await db.conversation.findMany({
        where: { id: { in: chatwootInvolvedIds } },
        select: { status: true, assigneeType: true },
      });
      for (const c of convs) {
        if (c.assigneeType === "User") handoff += 1;
        else if (c.status === "resolved") resolvedByBot += 1;
      }
    }
    if (whazingInvolvedIds.length > 0) {
      const convs = await db.whazingConversation.findMany({
        where: { id: { in: whazingInvolvedIds } },
        select: { status: true, assignedUserId: true },
      });
      for (const c of convs) {
        // assignedUserId != null: a human took over (mirrors Chatwoot's assigneeType === "User").
        if (c.assignedUserId != null) handoff += 1;
        else if (c.status === "resolved") resolvedByBot += 1;
      }
    }
    return {
      totalConversations,
      involved,
      resolvedByBot,
      handoff,
      involvementRate:
        totalConversations > 0 ? involved / totalConversations : 0,
      resolutionRate: involved > 0 ? resolvedByBot / involved : 0,
      automationRate:
        totalConversations > 0 ? resolvedByBot / totalConversations : 0,
    };
  });
}

export interface TimeseriesPoint {
  // Local day key (YYYY-MM-DD) in the requested timezone. See getTimeseries.
  bucket: string;
  calls: number;
  // Distinct conversations that had LLM usage that local day (COUNT DISTINCT conversation_id, NULLs
  // ignored). Feeds the cost-per-conversation line on the dashboard chart.
  conversations: number;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
}

// Daily LLM usage series for the dashboard chart. Raw SQL (date_trunc has no Prisma builder)
// runs INSIDE the scoped tx so RLS fences llm_usage to the tenant — never filter tenant_id by hand.
// Respects `filter.source` (omitted → all sources) so the chart tracks the selected segment.
//
// `bucket` is a LOCAL day key (YYYY-MM-DD) in `filter.tz`, not a UTC ISO instant, so a 22h-BRT turn
// (01h UTC) lands on the right local day instead of leaking into "tomorrow" in UTC. Returning the
// key as text (to_char) keeps it unambiguous on the client (no Date/timezone round-trip).
//   created_at is `timestamp WITHOUT time zone` (Prisma's default) holding the UTC wall-clock, so we
// double-shift: `AT TIME ZONE 'UTC'` reads the naive value AS UTC → a real instant (timestamptz),
// then `AT TIME ZONE $tz` renders that instant as wall-clock in the target zone. A single shift
// would (wrongly) interpret the stored value as already being in $tz.
export async function getTimeseries(
  ctx: TenantContext,
  filter: MetricsFilter = {},
  base: PrismaClient = basePrisma,
): Promise<TimeseriesPoint[]> {
  const since = filter.since ?? null;
  const source = filter.source ?? null;
  const tz = normalizeTimeZone(filter.tz);
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.$queryRaw<
      {
        bucket: string;
        calls: number;
        conversations: number;
        prompt: number;
        completion: number;
        cached: number;
      }[]
    >(Prisma.sql`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text), 'YYYY-MM-DD') AS bucket,
             COUNT(*)::int AS calls,
             COUNT(DISTINCT conversation_id)::int AS conversations,
             COALESCE(SUM(prompt_tokens), 0)::int AS prompt,
             COALESCE(SUM(completion_tokens), 0)::int AS completion,
             COALESCE(SUM(cached_read_tokens), 0)::int AS cached
      FROM llm_usage
      WHERE (${since}::timestamptz IS NULL OR created_at >= ${since})
        AND (${source}::text IS NULL OR source = ${source})
      GROUP BY bucket
      ORDER BY bucket ASC`);
    return rows.map((r) => ({
      bucket: r.bucket,
      calls: Number(r.calls),
      conversations: Number(r.conversations),
      promptTokens: Number(r.prompt),
      completionTokens: Number(r.completion),
      cachedReadTokens: Number(r.cached),
    }));
  });
}
