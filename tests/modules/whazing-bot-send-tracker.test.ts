import { describe, expect, test } from "bun:test";
import {
  markBotSent,
  wasRecentlyBotSent,
} from "@/modules/whazing/bot-send-tracker";

describe("bot-send-tracker", () => {
  test("returns false when nothing was ever sent to this ticket", () => {
    expect(wasRecentlyBotSent(999n, 1)).toBe(false);
  });

  test("returns true right after marking a send", () => {
    markBotSent(999n, 2);
    expect(wasRecentlyBotSent(999n, 2)).toBe(true);
  });

  test("is scoped per instance — same ticketId on a different instance is unaffected", () => {
    markBotSent(999n, 3);
    expect(wasRecentlyBotSent(1000n, 3)).toBe(false);
  });

  test("is scoped per ticket — a different ticket on the same instance is unaffected", () => {
    markBotSent(999n, 4);
    expect(wasRecentlyBotSent(999n, 5)).toBe(false);
  });
});
