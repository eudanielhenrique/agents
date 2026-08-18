// Whazing echoes every outbound message back through the SAME webhook (fromMe: true) — including
// our own API-sent replies. shouldWhazingBotHandle-adjacent code (isManualHumanReply) needs to
// tell "a human just typed this" apart from "this is the echo of what we just sent", and the field
// that was assumed to carry that signal (`sendType`, "bot"/"smartreception") turned out unreliable
// in practice: a real production ticket (no human involved at all) got `humanTakeoverAt` stamped
// ~14s after the bot's own first reply, self-silencing Lia for the rest of the conversation.
//
// This tracks OUR OWN sends instead — a signal we control completely, no dependency on how
// Whazing chooses to label the echo. In-memory, single-process: matches the same invariant as
// graph/inflight.ts (single-replica; a second replica would need a shared store).

const BOT_SEND_WINDOW_MS = 60_000;

const recentBotSends = new Map<string, number>();

function key(instanceId: bigint, ticketId: number): string {
  return `${instanceId}:${ticketId}`;
}

// Call right after successfully sending a reply to this ticket.
export function markBotSent(instanceId: bigint, ticketId: number): void {
  recentBotSends.set(key(instanceId, ticketId), Date.now());
}

// True when we sent this ticket a message within the last BOT_SEND_WINDOW_MS — the fromMe:true
// webhook now arriving is very likely the echo of that send, not a human typing directly.
export function wasRecentlyBotSent(
  instanceId: bigint,
  ticketId: number,
): boolean {
  const at = recentBotSends.get(key(instanceId, ticketId));
  if (at == null) return false;
  const fresh = Date.now() - at < BOT_SEND_WINDOW_MS;
  if (!fresh) recentBotSends.delete(key(instanceId, ticketId));
  return fresh;
}
