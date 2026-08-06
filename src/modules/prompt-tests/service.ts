import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import type { TraceEntry } from "@/graph/trace";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";

// Prompt regression test suite: single-turn scenarios saved per agent (a fixed user message +
// assertions), replayed against the agent's CURRENT saved prompt or an unsaved draft via the
// playground turn path — so a prompt edit can be checked for regressions before publishing, the
// same way the operator already tests by hand in the playground, just batched and repeatable.
// Results are NOT persisted (run-on-demand only); add a run-history table later only if a pass/
// fail trend over time is actually wanted.

export interface PromptTestAssertions {
  mustContain: string[];
  mustNotContain: string[];
  mustCallTool: string[];
  mustNotCallTool: string[];
}

function normalizeAssertions(raw: unknown): PromptTestAssertions {
  const a = (raw ?? {}) as Partial<PromptTestAssertions>;
  return {
    mustContain: Array.isArray(a.mustContain) ? a.mustContain : [],
    mustNotContain: Array.isArray(a.mustNotContain) ? a.mustNotContain : [],
    mustCallTool: Array.isArray(a.mustCallTool) ? a.mustCallTool : [],
    mustNotCallTool: Array.isArray(a.mustNotCallTool) ? a.mustNotCallTool : [],
  };
}

export interface PromptTestCaseDto {
  id: string;
  agentId: string;
  name: string;
  userMessage: string;
  assertions: PromptTestAssertions;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: {
  id: bigint;
  agentId: bigint;
  name: string;
  userMessage: string;
  assertions: unknown;
  createdAt: Date;
  updatedAt: Date;
}): PromptTestCaseDto {
  return {
    id: row.id.toString(),
    agentId: row.agentId.toString(),
    name: row.name,
    userMessage: row.userMessage,
    assertions: normalizeAssertions(row.assertions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SELECT = {
  id: true,
  agentId: true,
  name: true,
  userMessage: true,
  assertions: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listPromptTestCases(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<PromptTestCaseDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.promptTestCase.findMany({
      where: { agentId },
      select: SELECT,
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toDto);
}

export interface PromptTestCaseInput {
  name: string;
  userMessage: string;
  assertions: Partial<PromptTestAssertions>;
}

export async function createPromptTestCase(
  ctx: TenantContext,
  agentId: bigint,
  input: PromptTestCaseInput,
  base: PrismaClient = basePrisma,
): Promise<PromptTestCaseDto> {
  if (ctx.tenantId === null) throw new NotFoundError("agent not found");
  const tenantId = ctx.tenantId;
  const row = await runScopedOn(base, ctx, (db) =>
    db.promptTestCase.create({
      data: {
        tenantId,
        agentId,
        name: input.name.trim(),
        userMessage: input.userMessage,
        assertions: { ...normalizeAssertions(input.assertions) },
      },
      select: SELECT,
    }),
  );
  return toDto(row);
}

export async function updatePromptTestCase(
  ctx: TenantContext,
  testCaseId: bigint,
  patch: Partial<PromptTestCaseInput>,
  base: PrismaClient = basePrisma,
): Promise<PromptTestCaseDto> {
  return runScopedOn(base, ctx, async (db) => {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.userMessage !== undefined) data.userMessage = patch.userMessage;
    if (patch.assertions !== undefined) {
      data.assertions = normalizeAssertions(patch.assertions);
    }
    // updateMany so a cross-tenant id (invisible under RLS) yields count 0 → NotFound, rather
    // than a P2025 throw.
    const res = await db.promptTestCase.updateMany({
      where: { id: testCaseId },
      data,
    });
    if (res.count === 0) throw new NotFoundError("prompt test case not found");
    const row = await db.promptTestCase.findUniqueOrThrow({
      where: { id: testCaseId },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function deletePromptTestCase(
  ctx: TenantContext,
  testCaseId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const res = await runScopedOn(base, ctx, (db) =>
    db.promptTestCase.deleteMany({ where: { id: testCaseId } }),
  );
  if (res.count === 0) throw new NotFoundError("prompt test case not found");
}

export interface PromptTestResult {
  testCaseId: string;
  name: string;
  passed: boolean;
  failures: string[];
  reply: string;
  calledTools: string[];
}

const RUN_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function checkAssertions(
  tc: PromptTestCaseDto,
  reply: string,
  trace: TraceEntry[],
): { passed: boolean; failures: string[]; calledTools: string[] } {
  const failures: string[] = [];
  const lowerReply = reply.toLowerCase();
  const calledTools = trace
    .filter(
      (e): e is Extract<TraceEntry, { type: "tool_call" }> =>
        e.type === "tool_call",
    )
    .map((e) => e.name);

  for (const needle of tc.assertions.mustContain) {
    if (!lowerReply.includes(needle.toLowerCase())) {
      failures.push(`expected reply to contain "${needle}"`);
    }
  }
  for (const needle of tc.assertions.mustNotContain) {
    if (lowerReply.includes(needle.toLowerCase())) {
      failures.push(`expected reply to NOT contain "${needle}"`);
    }
  }
  for (const toolName of tc.assertions.mustCallTool) {
    if (!calledTools.includes(toolName)) {
      failures.push(`expected tool "${toolName}" to be called`);
    }
  }
  for (const toolName of tc.assertions.mustNotCallTool) {
    if (calledTools.includes(toolName)) {
      failures.push(`expected tool "${toolName}" NOT to be called`);
    }
  }
  return { passed: failures.length === 0, failures, calledTools };
}

export async function runPromptTestSuite(
  ctx: TenantContext,
  agentId: bigint,
  opts: { draftSystemPrompt?: string } = {},
  base: PrismaClient = basePrisma,
): Promise<PromptTestResult[]> {
  if (ctx.tenantId === null) {
    throw new NotFoundError("agent not found");
  }
  const tenantId = ctx.tenantId;
  const testCases = await listPromptTestCases(ctx, agentId, base);
  return mapWithConcurrency(testCases, RUN_CONCURRENCY, async (tc) => {
    const { reply, trace } = await runPlaygroundTurn({
      tenantId,
      agentId,
      message: tc.userMessage,
      overrides: opts.draftSystemPrompt
        ? { systemPrompt: opts.draftSystemPrompt }
        : undefined,
      base,
    });
    const { passed, failures, calledTools } = checkAssertions(tc, reply, trace);
    return {
      testCaseId: tc.id,
      name: tc.name,
      passed,
      failures,
      reply,
      calledTools,
    };
  });
}
