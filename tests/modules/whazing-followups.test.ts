import { describe, expect, test } from "bun:test";
import { isWhazingFollowUpLive } from "@/modules/whazing/followups";

// Full sweep/handler coverage against a live scheduler + tenancy stack lives outside this suite (no
// Whazing DB fixture helper exists yet — same gap noted for whazing-debounce.test.ts and
// whazing-nudge.test.ts). This covers the pure eligibility gate handleWhazingFollowUp and the sweep
// SQL both depend on.

function base() {
  return {
    agentEnabled: true,
    followUpEnabled: true,
    agentMode: "production",
    testActivatedAt: null,
    humanTakeoverAt: null,
    assignedUserId: null,
  };
}

describe("isWhazingFollowUpLive", () => {
  test("live when the agent is enabled, follow-up is on, and the bot still owns it", () => {
    expect(isWhazingFollowUpLive(base())).toBe(true);
  });

  test("not live when the agent is disabled", () => {
    expect(isWhazingFollowUpLive({ ...base(), agentEnabled: false })).toBe(
      false,
    );
  });

  test("not live when follow-up is off", () => {
    expect(isWhazingFollowUpLive({ ...base(), followUpEnabled: false })).toBe(
      false,
    );
  });

  test("not live for a test-mode agent not yet activated", () => {
    expect(isWhazingFollowUpLive({ ...base(), agentMode: "test" })).toBe(false);
  });

  test("live for a test-mode agent once activated", () => {
    expect(
      isWhazingFollowUpLive({
        ...base(),
        agentMode: "test",
        testActivatedAt: new Date(),
      }),
    ).toBe(true);
  });

  test("not live once a human takes over", () => {
    expect(
      isWhazingFollowUpLive({ ...base(), humanTakeoverAt: new Date() }),
    ).toBe(false);
  });

  test("not live once a human is assigned", () => {
    expect(isWhazingFollowUpLive({ ...base(), assignedUserId: 42 })).toBe(
      false,
    );
  });
});
