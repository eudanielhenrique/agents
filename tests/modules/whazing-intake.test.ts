import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  hasActivePriorHistory,
  resolveEscalateQueueId,
  resolveWhazingIntake,
} from "@/modules/whazing/intake";
import {
  readWhazingIntakeConfig,
  WHAZING_INTAKE_DEFAULTS,
} from "@/modules/whazing/intake-settings";

function makeMockPrisma(opts: {
  instance?: { settings: unknown } | null;
  inboxes?: Array<{
    whazingQueueId: string | null;
    agent: { settings: unknown } | null;
  }>;
  onInboxFindMany?: (args: unknown) => void;
}) {
  const db = {
    $executeRaw: async () => {},
    whazingInstance: {
      findUnique: async () => opts.instance ?? null,
    },
    whazingInbox: {
      findMany: async (args: unknown) => {
        opts.onInboxFindMany?.(args);
        return opts.inboxes ?? [];
      },
    },
  };
  return {
    $extends: () => ({
      $transaction: async <T>(cb: (tx: typeof db) => Promise<T>) => cb(db),
    }),
  } as unknown as PrismaClient;
}

describe("readWhazingIntakeConfig", () => {
  test("returns defaults for undefined/null/empty object", () => {
    expect(readWhazingIntakeConfig(null)).toEqual(WHAZING_INTAKE_DEFAULTS);
    expect(readWhazingIntakeConfig(undefined)).toEqual(WHAZING_INTAKE_DEFAULTS);
    expect(readWhazingIntakeConfig({})).toEqual(WHAZING_INTAKE_DEFAULTS);
  });

  test("parses intake nested under settings.intake", () => {
    const config = readWhazingIntakeConfig({
      intake: {
        historyRoutingEnabled: true,
        escalateQueueId: 15,
        botQueueId: 14,
        campaignEnabled: true,
        campaignTagId: 31,
        campaignNotifyPhone: "5527999594959",
        campaignNotifyMessage: "Custom lead message: {{ctwaClid}}",
      },
    });

    expect(config.historyRoutingEnabled).toBe(true);
    expect(config.escalateQueueId).toBe(15);
    expect(config.botQueueId).toBe(14);
    expect(config.campaignEnabled).toBe(true);
    expect(config.campaignTagId).toBe(31);
    expect(config.campaignNotifyPhone).toBe("5527999594959");
    expect(config.campaignNotifyMessage).toBe(
      "Custom lead message: {{ctwaClid}}",
    );
  });

  test("parses intake nested under settings.whazingIntake (legacy)", () => {
    const config = readWhazingIntakeConfig({
      whazingIntake: {
        historyRoutingEnabled: true,
        escalateQueueId: 33,
        botQueueId: 32,
        campaignEnabled: true,
        campaignTagId: 52,
        campaignNotifyPhone: "5527999594959",
      },
    });

    expect(config.historyRoutingEnabled).toBe(true);
    expect(config.escalateQueueId).toBe(33);
    expect(config.botQueueId).toBe(32);
    expect(config.campaignEnabled).toBe(true);
    expect(config.campaignTagId).toBe(52);
    expect(config.campaignNotifyPhone).toBe("5527999594959");
    expect(config.campaignNotifyMessage).toBe(
      WHAZING_INTAKE_DEFAULTS.campaignNotifyMessage,
    );
  });

  test("parses flat settings bag", () => {
    const config = readWhazingIntakeConfig({
      historyRoutingEnabled: true,
      escalateQueueId: 24,
      botQueueId: 40,
      campaignEnabled: false,
    });

    expect(config.historyRoutingEnabled).toBe(true);
    expect(config.escalateQueueId).toBe(24);
    expect(config.botQueueId).toBe(40);
    expect(config.campaignEnabled).toBe(false);
  });

  test("clamps non-positive-integer queue and tag IDs to null", () => {
    const config = readWhazingIntakeConfig({
      intake: {
        historyRoutingEnabled: true,
        escalateQueueId: "invalid" as unknown as number,
        botQueueId: -5,
        campaignTagId: 0,
      },
    });

    expect(config.escalateQueueId).toBeNull();
    expect(config.botQueueId).toBeNull();
    expect(config.campaignTagId).toBeNull();
  });
});

describe("resolveWhazingIntake", () => {
  test("resolves from instance.settings directly when configured", async () => {
    let inboxQueried = false;
    const mockPrisma = makeMockPrisma({
      instance: {
        settings: {
          intake: {
            historyRoutingEnabled: true,
            escalateQueueId: 15,
            botQueueId: 14,
            campaignEnabled: true,
            campaignTagId: 31,
            campaignNotifyPhone: "5527999594959",
          },
        },
      },
      onInboxFindMany: () => {
        inboxQueried = true;
      },
    });

    const res = await resolveWhazingIntake(mockPrisma, BigInt(1), BigInt(2));
    expect(res).not.toBeNull();
    expect(res?.botQueueId).toBe("14");
    expect(res?.intake.historyRoutingEnabled).toBe(true);
    expect(res?.intake.escalateQueueId).toBe(15);
    expect(res?.intake.campaignEnabled).toBe(true);
    expect(res?.intake.campaignTagId).toBe(31);
    expect(res?.intake.campaignNotifyPhone).toBe("5527999594959");
    // Should NOT have queried inboxes because instance settings took precedence
    expect(inboxQueried).toBe(false);
  });

  test("falls back to legacy agent settings only when agent is enabled", async () => {
    const captured: { where: { agent?: { enabled?: boolean } } | null } = {
      where: null,
    };
    const mockPrisma = makeMockPrisma({
      instance: {
        settings: {}, // No instance intake settings
      },
      inboxes: [
        {
          whazingQueueId: "14",
          agent: {
            settings: {
              whazingIntake: {
                historyRoutingEnabled: true,
                escalateQueueId: 15,
                campaignEnabled: true,
                campaignTagId: 31,
              },
            },
          },
        },
      ],
      onInboxFindMany: (args) => {
        captured.where =
          (args as { where?: { agent?: { enabled?: boolean } } })?.where ??
          null;
      },
    });

    const res = await resolveWhazingIntake(mockPrisma, BigInt(1), BigInt(2));
    expect(res).not.toBeNull();
    expect(res?.botQueueId).toBe("14");
    expect(res?.intake.historyRoutingEnabled).toBe(true);
    expect(res?.intake.escalateQueueId).toBe(15);
    // Crucial: query MUST filter by agent: { enabled: true }
    expect(captured.where?.agent).toEqual({ enabled: true });
  });

  test("returns null when instance settings are empty and agent query returns no enabled agents", async () => {
    const mockPrisma = makeMockPrisma({
      instance: {
        settings: {},
      },
      inboxes: [], // No enabled agents match
    });

    const res = await resolveWhazingIntake(mockPrisma, BigInt(1), BigInt(2));
    expect(res).toBeNull();
  });
});

describe("resolveEscalateQueueId", () => {
  test("returns escalateQueueId from resolved instance intake", async () => {
    const mockPrisma = makeMockPrisma({
      instance: {
        settings: {
          intake: {
            historyRoutingEnabled: true,
            escalateQueueId: 33,
          },
        },
      },
    });

    const qid = await resolveEscalateQueueId(mockPrisma, BigInt(1), BigInt(1));
    expect(qid).toBe(33);
  });

  test("returns null when no intake is resolved", async () => {
    const mockPrisma = makeMockPrisma({
      instance: {
        settings: {},
      },
      inboxes: [],
    });

    const qid = await resolveEscalateQueueId(mockPrisma, BigInt(1), BigInt(1));
    expect(qid).toBeNull();
  });
});

describe("hasActivePriorHistory", () => {
  test("false when the only ticket for this phone is the current one", () => {
    expect(hasActivePriorHistory(2, [{ id: 2, status: "pending" }])).toBe(
      false,
    );
  });

  test("false when every OTHER ticket for this phone is closed", () => {
    expect(
      hasActivePriorHistory(3, [
        { id: 1, status: "closed" },
        { id: 2, status: "closed" },
        { id: 3, status: "pending" },
      ]),
    ).toBe(false);
  });

  test("true when another ticket for this phone is still open/pending", () => {
    expect(
      hasActivePriorHistory(3, [
        { id: 1, status: "closed" },
        { id: 2, status: "pending" },
        { id: 3, status: "pending" },
      ]),
    ).toBe(true);
  });

  test("true when another ticket is open (not just pending)", () => {
    expect(
      hasActivePriorHistory(2, [
        { id: 1, status: "open" },
        { id: 2, status: "pending" },
      ]),
    ).toBe(true);
  });
});

describe("runWhazingIntake", () => {
  test("defaults to bot with botQueueId null when instance has no intake configuration", async () => {
    const { runWhazingIntake } = await import("@/modules/whazing/intake");
    const mockPrisma = makeMockPrisma({
      instance: { settings: {} },
      inboxes: [],
    });

    const routing = await runWhazingIntake({
      tenantId: BigInt(1),
      instanceId: BigInt(4),
      event: {
        event: "message_received",
        ticketId: 12949,
        queueId: 32,
        assignedUserId: null,
        status: "pending",
        sendType: null,
        campaignSignal: null,
        contact: {
          id: 5151,
          name: "Daniel H",
          phone: "5527988693358",
          whatsappId: null,
        },
        message: {
          id: "msg-1",
          body: "Oi",
          fromMe: false,
          isAutomation: false,
          attachments: [],
          timestamp: Date.now(),
        },
      },
      base: mockPrisma,
    });

    expect(routing).toEqual({ routedTo: "bot", botQueueId: null });
  });
});
