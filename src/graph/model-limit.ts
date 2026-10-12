import logger from "@/api/lib/logger";
import config from "@/config";
import { Semaphore } from "@/lib/semaphore";

// Policy point for every agent model call: the LLM round-trip in the LangGraph agent node
// (graph.ts), the guardrail classifier and the opt-in TTS-normalize call. It caps how many calls are
// in flight so a burst does not hammer the provider, and it recovers the one provider fault
// LangChain cannot see. One semaphore PER TENANT (not a single global pool): a tenant stuck in a
// retry storm or traffic spike only exhausts its own slots, never another tenant's. Callers that
// cannot cheaply thread a tenantId through yet (guardrail, TTS-normalize) fall back to a shared
// bucket — same behavior they always had, not a regression.
// ponytail: guardrail/TTS-normalize still share one bucket; give them their own tenant key too
// if a tenant's guardrail/TTS traffic alone turns out to matter.
// Singleton on globalThis so `bun --hot` reloads reuse the same instances (same pattern as
// worker.ts / checkpointer.ts).

const KEY = Symbol.for("fazerai.model.semaphores");
const SHARED_BUCKET = "shared";

function semaphores(): Map<string, Semaphore> {
  const g = globalThis as unknown as Record<symbol, Map<string, Semaphore>>;
  g[KEY] ??= new Map();
  return g[KEY];
}

function sem(tenantId?: bigint | string): Semaphore {
  const key = tenantId === undefined ? SHARED_BUCKET : String(tenantId);
  const pools = semaphores();
  let s = pools.get(key);
  if (!s) {
    s = new Semaphore(config.agent.modelConcurrency);
    pools.set(key, s);
  }
  return s;
}

// NOTE: short on purpose — a customer is waiting on the other end of this call.
const RETRY_DELAY_MS = 250;

// NOTE: `TypeError` is the predicate, and it is narrow by design. LangChain's AsyncCaller already
// retries everything the PROVIDER answered (6 attempts with backoff, aborting on 4xx), and the
// OpenAI SDK's own retry is disabled in favour of it. What no retry covers is a 200 whose body
// carries no completion: the provider returns `choices: []`, `_generate` returns
// `{ generations: [] }`, the call RESOLVES, and only afterwards does BaseChatModel.invoke raise a
// TypeError reading `generations[0][0].message`. That is issue #63 — an intermittent fault ended
// the turn and the customer got no reply at all.
//
// Everything the provider actually answered arrives as a plain Error (an APIError carries `status`,
// a timeout is named AbortError/TimeoutError, an oversized prompt is ContextOverflowError), so a
// "retry unless 4xx" predicate would have to enumerate those three exclusions, double the latency
// of failures that are already decided, and still miss the next such class.
//
// The failing expression is the only signal there is: the provider answered 200, so there is no
// status, no code and no typed error to match on. Bun (JavaScriptCore) puts that expression in the
// message — `undefined is not an object (evaluating '…generations[0][0].message')` — and Bun is what
// the deploy runs. Matching it, rather than any TypeError, matters because `runModelCall` wraps
// `invoke`, and LangChain runs its callback handlers INSIDE that: a TypeError from a tracing
// callback fires after the provider already answered and was already billed, so retrying it would
// pay for the same completion twice, every turn, until the callback is fixed.
//
// If a future runtime words the message differently the retry stops firing, which is the behaviour
// that shipped before this change — a silent no-op, never a wrong retry.
function isEmptyCompletionFault(err: unknown): boolean {
  return err instanceof TypeError && err.message.includes("generations");
}

// That same message lands verbatim in Conversation.lastError and in the flow log. Name what happened
// instead, keeping the original as `cause`. An error that is NOT this fault travels untouched, so
// the message never claims a cause it does not have.
function describeEmptyCompletion(err: unknown): unknown {
  if (isEmptyCompletionFault(err)) {
    return new Error(
      "the model provider returned no completion (empty generations)",
      { cause: err },
    );
  }
  return err;
}

export async function runModelCall<T>(
  fn: () => Promise<T>,
  // Fired when a call is retried, so the runtime can leave a warn on the turn's trail. Best-effort.
  onRetry?: (info: { attempt: number; error: unknown }) => void,
  // The tenant this call is billed to — isolates its semaphore slots from every other tenant's.
  // Omitted by callers that do not have one cheaply in scope yet; they share one pool, exactly as
  // every caller did before per-tenant isolation existed.
  tenantId?: bigint | string,
): Promise<T> {
  return sem(tenantId).run(async () => {
    try {
      return await fn();
    } catch (err) {
      if (!isEmptyCompletionFault(err)) throw err;
      onRetry?.({ attempt: 1, error: err });
      logger.warn(
        { err },
        "model call returned no completion; retrying once before failing the turn",
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        return await fn();
      } catch (retryErr) {
        throw describeEmptyCompletion(retryErr);
      }
    }
  });
}
