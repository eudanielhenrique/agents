import { describe, expect, test } from "bun:test";
import { shouldWhazingBotHandle } from "@/modules/whazing/normalize";
import {
  extractTagValues,
  hasIgnoredTag,
  readIgnoredTagsFromSettings,
} from "@/modules/whazing/tags";
import type { NormalizedWhazingEvent } from "@/modules/whazing/types";

describe("Whazing tags handling", () => {
  test("extractTagValues handles numbers, strings, and objects", () => {
    expect(extractTagValues(71)).toEqual(["71"]);
    expect(extractTagValues("71")).toEqual(["71"]);
    expect(extractTagValues([71, "80", { id: 90, name: "Suporte" }])).toEqual([
      "71",
      "80",
      "90",
      "Suporte",
    ]);
    expect(extractTagValues(null)).toEqual([]);
    expect(extractTagValues(undefined)).toEqual([]);
  });

  test("hasIgnoredTag detects matching tags case-insensitively and with string/number equivalence", () => {
    expect(hasIgnoredTag([71], [71])).toBe(true);
    expect(hasIgnoredTag(["71"], [71])).toBe(true);
    expect(hasIgnoredTag([71], ["71"])).toBe(true);
    expect(hasIgnoredTag([{ id: 71, name: "Ignorar" }], [71])).toBe(true);
    expect(hasIgnoredTag([{ id: 72, name: "71" }], ["71"])).toBe(true);
    expect(hasIgnoredTag(["suporte"], ["Suporte"])).toBe(true);

    expect(hasIgnoredTag([72], [71])).toBe(false);
    expect(hasIgnoredTag([], [71])).toBe(false);
    expect(hasIgnoredTag(null, [71])).toBe(false);
    expect(hasIgnoredTag([71], [])).toBe(false);
  });

  test("readIgnoredTagsFromSettings extracts ignoredTags from top-level and whazingIntake", () => {
    expect(readIgnoredTagsFromSettings({ ignoredTags: [71, "80"] })).toEqual([
      "71",
      "80",
    ]);
    expect(readIgnoredTagsFromSettings({ excludedTags: ["71"] })).toEqual([
      "71",
    ]);
    expect(
      readIgnoredTagsFromSettings({
        whazingIntake: { ignoredTags: [71] },
      }),
    ).toEqual(["71"]);
    expect(readIgnoredTagsFromSettings({})).toEqual([]);
  });

  test("shouldWhazingBotHandle ignores events when candidate tags match ignoredTags", () => {
    const baseEvent: NormalizedWhazingEvent = {
      event: "message_received",
      ticketId: 100,
      queueId: 1,
      assignedUserId: null,
      status: "pending",
      sendType: null,
      campaignSignal: null,
      contact: {
        id: 200,
        name: "Test",
        phone: "5511999999999",
        whatsappId: "5511999999999@s.whatsapp.net",
      },
      message: {
        id: "msg-1",
        body: "Olá",
        fromMe: false,
        isAutomation: false,
        attachments: [],
        timestamp: 1000,
      },
    };

    // No ignored tags -> should handle
    expect(shouldWhazingBotHandle(baseEvent, [71])).toBe(true);

    // Event with tag 71 on ticket -> should NOT handle
    const taggedEvent: NormalizedWhazingEvent = {
      ...baseEvent,
      tags: ["71"],
    };
    expect(shouldWhazingBotHandle(taggedEvent, [71])).toBe(false);
    expect(shouldWhazingBotHandle(taggedEvent, ["71"])).toBe(false);

    // Event with tag 71 on contact -> should NOT handle
    const taggedContactEvent: NormalizedWhazingEvent = {
      ...baseEvent,
      contact: {
        id: 200,
        name: "Test",
        phone: "5511999999999",
        whatsappId: "5511999999999@s.whatsapp.net",
        tags: ["71"],
      },
    };
    expect(shouldWhazingBotHandle(taggedContactEvent, [71])).toBe(false);

    // Event with different tag 72 -> should handle
    const otherTagEvent: NormalizedWhazingEvent = {
      ...baseEvent,
      tags: ["72"],
    };
    expect(shouldWhazingBotHandle(otherTagEvent, [71])).toBe(true);
  });
});
