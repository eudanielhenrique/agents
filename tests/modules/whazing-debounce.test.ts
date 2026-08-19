import { describe, expect, test } from "bun:test";
import {
  parseWhazingDebouncePayload,
  whazingDebounceDedupeKey,
} from "@/modules/whazing/debounce";

// Full arm/flush coverage against a live scheduler + tenancy stack lives outside this suite (no
// Whazing DB fixture helper exists yet — mirrors seedChatwootInstance's absence for Whazing). The
// real correctness gate for this feature is the live Whazing retest in the rollout plan (send two
// messages back-to-back, confirm one coalesced reply instead of the second dropping with
// `outcome=no-agent`). These cover the payload contract both armWhazingDebounce and
// flushWhazingDebounceJob depend on.

describe("whazingDebounceDedupeKey", () => {
  test("namespaces by thread id", () => {
    expect(whazingDebounceDedupeKey("tenant:1:whazing:1:ticket:11376")).toBe(
      "whazing-debounce:tenant:1:whazing:1:ticket:11376",
    );
  });
});

describe("parseWhazingDebouncePayload", () => {
  test("round-trips a well-formed payload", () => {
    const payload = {
      threadId: "tenant:1:whazing:1:ticket:11376",
      ticketId: 11376,
      instanceId: "1",
      queueId: 32,
      texts: ["Qual dia da tarde.", "Vocês aceitam convênio?"],
      burstStartedAt: 1000,
      contactId: 42,
      rawContactName: "Daniel",
    };
    expect(parseWhazingDebouncePayload(payload)).toEqual(payload);
  });

  test("defaults missing optional fields", () => {
    const parsed = parseWhazingDebouncePayload({
      threadId: "t",
      ticketId: 1,
      instanceId: "1",
      texts: ["oi"],
    });
    expect(parsed?.queueId).toBeNull();
    expect(parsed?.contactId).toBeNull();
    expect(parsed?.rawContactName).toBeNull();
    expect(typeof parsed?.burstStartedAt).toBe("number");
  });

  test("drops non-string entries from texts", () => {
    const parsed = parseWhazingDebouncePayload({
      threadId: "t",
      ticketId: 1,
      instanceId: "1",
      texts: ["oi", 42, null, "tudo bem?"],
    });
    expect(parsed?.texts).toEqual(["oi", "tudo bem?"]);
  });

  test("rejects a shape missing required fields", () => {
    expect(parseWhazingDebouncePayload({ threadId: "t" })).toBeNull();
    expect(parseWhazingDebouncePayload(null)).toBeNull();
    expect(parseWhazingDebouncePayload("not an object")).toBeNull();
  });
});
