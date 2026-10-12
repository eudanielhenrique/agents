import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { runDebounceTick } from "@/modules/debounce/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// End-to-end parallelism harness (no Chatwoot, no LLM): drives N real turns through the actual tick
// (runDebounceTick → flushDebounceJob → graph → runModelCall) with a stub Chatwoot client and a fake
// model that SLEEPS (simulating LLM latency) and records how many calls are in flight at once. Proves
// the fix empirically: turns overlap in time (not serial) and the model semaphore caps them.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const REPLY = "Claro, posso ajudar!";
const CHATWOOT_INBOX_ID = 7;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

// Fake chat model: sleeps `delayMs` (LLM latency) and tracks concurrent in-flight calls via a shared
// meter. bindTools returns self so it works whether or not the runtime binds native tools.
function sleepyModel(delayMs: number, meter: { active: number; max: number }) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke(_messages: BaseMessage[]) {
      meter.active += 1;
      meter.max = Math.max(meter.max, meter.active);
      try {
        await sleep(delayMs);
        return new AIMessage(REPLY);
      } finally {
        meter.active -= 1;
      }
    },
  };
  return model as unknown as BaseChatModel;
}

// One new incoming message per conversation; sendMessage records the post. Shared across turns —
// getMessages keys off conversationId, so each turn sees its own message.
function parallelStub(sent: Array<[number, string]>) {
  const client = {
    getMessages: async (conversationId: number) => ({
      payload: [
        {
          id: 100,
          content: `oi da conversa ${conversationId}`,
          message_type: 0,
          private: false,
        },
      ],
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: null,
    },
  });
}

function jobFor(convId: number): ClaimedJob {
  return {
    id: 1n,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    attempts: 0,
  };
}

describe.skipIf(!dbUp)("debounce parallelism", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DBP", slug: `dbp-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          debounce: { enabled: true, windowSeconds: 15 },
          split: { enabled: false },
        },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `dbp-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "llm_usage",
        "conversations",
        "inboxes",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("N conversations drain in parallel, capped at the model semaphore", async () => {
    const cap = config.agent.modelConcurrency;
    const M = cap + 5;
    const delayMs = 100;
    const convIds = Array.from({ length: M }, (_, i) => 1000 + i);
    for (const id of convIds) await seedConversation(id);

    const meter = { active: 0, max: 0 };
    const sent: Array<[number, string]> = [];
    const jobs = convIds.map((id) => jobFor(id));

    const started = performance.now();
    const out = await runDebounceTick(appDb, M, {
      claim: async () => jobs,
      run: (job) =>
        flushDebounceJob({
          job,
          base: appDb,
          deps: {
            makeModel: () => sleepyModel(delayMs, meter),
            makeClient: parallelStub(sent),
            checkpointer: new MemorySaver(),
          },
        }).then(() => {}),
    });
    const elapsed = performance.now() - started;

    console.log(
      `[parallelism] ${M} conversas, cap do modelo ${cap}: concorrente ${Math.round(elapsed)}ms vs serial ~${M * delayMs}ms; pico de concorrência ${meter.max}`,
    );

    expect(out.claimed).toBe(M);
    // Every conversation answered exactly once (no turn stuck/dropped under concurrency).
    expect(sent.length).toBe(M);
    // Concurrency reached significant parallelism (serial would peak at 1) and never exceeds the semaphore cap.
    expect(meter.max).toBeGreaterThanOrEqual(10);
    expect(meter.max).toBeLessThanOrEqual(cap);
    // Anti-serial guard, generous to avoid timing flakiness: serial would be ~M*delayMs (the real
    // number is in the log). meter.max >= 10 above is the strong, deterministic proof of parallelism.
    expect(elapsed).toBeLessThan(M * delayMs);
  });
});
