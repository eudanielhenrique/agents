import { describe, expect, test } from "bun:test";
import {
  extractLastTicketMessage,
  readWhazingHumanSlaConfig,
  WHAZING_HUMAN_SLA_DEFAULTS,
} from "@/modules/whazing/human-sla";

describe("readWhazingHumanSlaConfig", () => {
  test("returns defaults for null/undefined/empty input", () => {
    expect(readWhazingHumanSlaConfig(null)).toEqual(WHAZING_HUMAN_SLA_DEFAULTS);
    expect(readWhazingHumanSlaConfig(undefined)).toEqual(
      WHAZING_HUMAN_SLA_DEFAULTS,
    );
    expect(readWhazingHumanSlaConfig({})).toEqual(WHAZING_HUMAN_SLA_DEFAULTS);
  });

  test("parses nested humanSla block correctly", () => {
    const input = {
      humanSla: {
        enabled: true,
        timeoutMinutes: 5,
        escalateQueueId: 24,
        botQueueId: 40,
        bypassOutOfHours: true,
      },
    };
    expect(readWhazingHumanSlaConfig(input)).toEqual({
      enabled: true,
      timeoutMinutes: 5,
      minutes: 5,
      hoursId: null,
      escalateQueueId: 24,
      botQueueId: 40,
      bypassOutOfHours: true,
    });
  });

  test("supports custom timeoutMinutes and clamps values", () => {
    const input1 = {
      humanSla: {
        enabled: true,
        timeoutMinutes: 10,
      },
    };
    expect(readWhazingHumanSlaConfig(input1).timeoutMinutes).toBe(10);

    // Clamps below 1 to 1
    const input2 = {
      humanSla: {
        enabled: true,
        timeoutMinutes: 0,
      },
    };
    expect(readWhazingHumanSlaConfig(input2).timeoutMinutes).toBe(1);

    // Clamps above 1440 (24h) to 1440
    const input3 = {
      humanSla: {
        enabled: true,
        timeoutMinutes: 2000,
      },
    };
    expect(readWhazingHumanSlaConfig(input3).timeoutMinutes).toBe(1440);
  });

  test("accepts string timeout representation", () => {
    const input = {
      humanSla: {
        enabled: true,
        timeoutMinutes: "15",
      },
    };
    expect(readWhazingHumanSlaConfig(input).timeoutMinutes).toBe(15);
  });

  test("supports alternative key 'sla'", () => {
    const input = {
      sla: {
        enabled: true,
        timeout: 7,
        escalateQueueId: 24,
        botQueueId: 40,
      },
    };
    expect(readWhazingHumanSlaConfig(input)).toEqual({
      enabled: true,
      timeoutMinutes: 7,
      minutes: 7,
      hoursId: null,
      escalateQueueId: 24,
      botQueueId: 40,
      bypassOutOfHours: true,
    });
  });
});

describe("extractLastTicketMessage", () => {
  test("returns null for malformed ticket", () => {
    expect(extractLastTicketMessage(null)).toBeNull();
    expect(extractLastTicketMessage({})).toBeNull();
    expect(extractLastTicketMessage({ messages: [] })).toBeNull();
  });

  test("extracts the most recent message correctly", () => {
    const ticket = {
      messages: [
        {
          id: "msg-1",
          body: "Primeira mensagem",
          fromMe: false,
          createdAt: "2026-10-15T08:00:00.000Z",
        },
        {
          id: "msg-2",
          body: "Segunda mensagem",
          fromMe: true,
          createdAt: "2026-10-15T08:02:00.000Z",
        },
        {
          id: "msg-3",
          body: "Terceira mensagem do cliente",
          fromMe: false,
          createdAt: "2026-10-15T08:05:00.000Z",
        },
      ],
    };
    const extracted = extractLastTicketMessage(ticket);
    expect(extracted).not.toBeNull();
    expect(extracted?.id).toBe("msg-3");
    expect(extracted?.body).toBe("Terceira mensagem do cliente");
    expect(extracted?.fromMe).toBe(false);
  });

  test("identifies when latest message was from staff (fromMe = true)", () => {
    const ticket = {
      messages: [
        {
          id: "msg-1",
          body: "Cliente falou",
          fromMe: false,
          createdAt: "2026-10-15T08:00:00.000Z",
        },
        {
          id: "msg-2",
          body: "Secretária respondeu",
          fromMe: true,
          createdAt: "2026-10-15T08:01:00.000Z",
        },
      ],
    };
    const extracted = extractLastTicketMessage(ticket);
    expect(extracted?.fromMe).toBe(true);
  });
});
