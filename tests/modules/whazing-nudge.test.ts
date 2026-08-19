import { describe, expect, test } from "bun:test";
import { SERVICE_WINDOW_DEFAULTS } from "@/modules/service-window/service";
import { decideWhazingNudgeDelivery } from "@/modules/whazing/nudge";

// Full runWhazingAgentNudge coverage against a live scheduler + tenancy stack lives outside this
// suite (no Whazing DB fixture helper exists yet — same gap noted for whazing-debounce.test.ts). The
// real correctness gate is the live test in the rollout plan (book a test appointment, confirm the
// reminder lands or falls back to a note). This covers the pure window-mode decision that
// runWhazingAgentNudge's delivery branch depends on — specifically that it NEVER picks "template"
// (WhazingClient has no send-template capability yet), unlike Chatwoot's proactiveSendMode.

describe("decideWhazingNudgeDelivery", () => {
  const cfg = { ...SERVICE_WINDOW_DEFAULTS, enabled: true, windowHours: 24 };
  const now = new Date("2026-08-19T12:00:00Z");

  test("inside the window sends freeform", () => {
    const lastInboundAt = new Date("2026-08-19T06:00:00Z"); // 6h ago
    expect(decideWhazingNudgeDelivery(cfg, lastInboundAt, now)).toBe(
      "freeform",
    );
  });

  test("outside the window falls back to a note, never a template", () => {
    const lastInboundAt = new Date("2026-08-18T06:00:00Z"); // 30h ago
    expect(decideWhazingNudgeDelivery(cfg, lastInboundAt, now)).toBe("note");
  });

  test("never inbound at all is treated as outside the window", () => {
    expect(decideWhazingNudgeDelivery(cfg, null, now)).toBe("note");
  });

  test("gate disabled always sends freeform regardless of last inbound", () => {
    const disabled = { ...cfg, enabled: false };
    const longAgo = new Date("2026-01-01T00:00:00Z");
    expect(decideWhazingNudgeDelivery(disabled, longAgo, now)).toBe("freeform");
    expect(decideWhazingNudgeDelivery(disabled, null, now)).toBe("freeform");
  });

  test("a template configured on the agent still does not change the outcome", () => {
    const withTemplate = { ...cfg, templateName: "reminder_hsm" };
    const lastInboundAt = new Date("2026-08-18T06:00:00Z");
    expect(decideWhazingNudgeDelivery(withTemplate, lastInboundAt, now)).toBe(
      "note",
    );
  });
});
