// Whazing echoes every outbound message back through the SAME webhook (fromMe: true) — including
// our own API-sent replies. shouldWhazingBotHandle-adjacent code (isManualHumanReply) needs to
// tell "a human just typed this" apart from "this is the echo of what we just sent", and the field
// that was assumed to carry that signal (\`sendType\`, "bot"/"smartreception") turned out unreliable
// in practice: a real production ticket (no human involved at all) got \`humanTakeoverAt\` stamped
// ~14s after the bot's own first reply, self-silencing Lia for the rest of the conversation.
//
// A pure time window over-corrected the other way: a human who replies fast (common — an operator
// watching the same ticket) lands inside the window and gets silently treated as "our own echo",
// so the bot keeps answering right alongside them (2026-09-18, tenant 2/VAX, tickets 14065/14072 —
// Eduarda typed within ~30s of the bot's last send, twice, and the bot never registered takeover).
// This tracks the ACTUAL TEXT we sent, not just a timestamp: an incoming fromMe:true event is only
// "our own echo" when its body matches something we genuinely just sent. A human's own words never
// match, so they register as a takeover immediately regardless of timing — while a real echo of the
// bot's own message (whatever sendType Whazing stamps on it) still gets recognized and ignored.
//
// This tracks OUR OWN sends instead — a signal we control completely, no dependency on how
// Whazing chooses to label the echo. In-memory, single-process: matches the same invariant as
// graph/inflight.ts (single-replica; a second replica would need a shared store).

const BOT_SEND_WINDOW_MS = 60_000;
// A ticket rarely gets more than a few balloons per turn; cap so a very chatty turn can't leak
// memory, and the oldest entries fall off before they'd matter (past BOT_SEND_WINDOW_MS anyway).
const MAX_TRACKED_PER_TICKET = 10;

interface SentEntry {
  text: string;
  at: number;
}

const recentBotSends = new Map<string, SentEntry[]>();

function key(instanceId: bigint, ticketId: number): string {
  return `${instanceId}:${ticketId}`;
}

// Loose match: trims + collapses whitespace so a trivial formatting difference in the echo (e.g.
// a trailing newline Whazing adds) doesn't defeat the comparison. Not fuzzy beyond that — an
// unrelated human message essentially never collides with this.
function normalize(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ");
}

// Call right after successfully sending a reply (or one balloon of a split reply) to this ticket.
export function markBotSent(
  instanceId: bigint,
  ticketId: number,
  text?: string | null,
): void {
  const k = key(instanceId, ticketId);
  const now = Date.now();
  const entries = (recentBotSends.get(k) ?? []).filter(
    (e) => now - e.at < BOT_SEND_WINDOW_MS,
  );
  entries.push({ text: normalize(text), at: now });
  recentBotSends.set(k, entries.slice(-MAX_TRACKED_PER_TICKET));
}

// True when the incoming text matches something we sent to this ticket within the last
// BOT_SEND_WINDOW_MS — the fromMe:true webhook now arriving is very likely the echo of that send,
// not a human typing directly. A non-matching text (any real human reply, whatever its timing)
// returns false.
export function wasRecentlyBotSent(
  instanceId: bigint,
  ticketId: number,
  incomingText?: string | null,
): boolean {
  const k = key(instanceId, ticketId);
  const now = Date.now();
  const entries = recentBotSends.get(k);
  if (!entries || entries.length === 0) return false;
  const fresh = entries.filter((e) => now - e.at < BOT_SEND_WINDOW_MS);
  if (fresh.length !== entries.length) {
    if (fresh.length === 0) recentBotSends.delete(k);
    else recentBotSends.set(k, fresh);
  }
  if (fresh.length === 0) return false;

  const needle = normalize(incomingText);
  if (!needle) return true;
  return fresh.some((e) => !e.text || e.text === needle);
}
