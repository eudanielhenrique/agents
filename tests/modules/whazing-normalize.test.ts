import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isNewIncomingMessage,
  normalizeWhazingEvent,
  shouldWhazingBotHandle,
  whazingDeliveryId,
} from "@/modules/whazing/normalize";
import {
  WHAZING_WEBHOOK_MOUNT,
  whazingWebhookUrl,
} from "@/modules/whazing/webhook-mount";

// ── webhook mount constant + URL derivation (unit) ───────────────────────────

describe("whazing webhook mount", () => {
  test("mount constant is the canonical receiver path", () => {
    expect(WHAZING_WEBHOOK_MOUNT).toBe("/api/v1/whazing/webhook");
  });

  test("whazingWebhookUrl derives from the mount constant; trailing slash trimmed", () => {
    expect(whazingWebhookUrl("http://localhost:3000", "tok")).toBe(
      "http://localhost:3000/api/v1/whazing/webhook/tok",
    );
    expect(whazingWebhookUrl("https://x/", "tok")).toBe(
      "https://x/api/v1/whazing/webhook/tok",
    );
  });
});

// ── whazingDeliveryId ─────────────────────────────────────────────────────────

describe("whazingDeliveryId", () => {
  test("returns the message id when present", () => {
    expect(whazingDeliveryId("msg-123", "any body")).toBe("msg-123");
  });

  test("returns a SHA-256 body digest when messageId is null", () => {
    const body = '{"event":"message_received"}';
    const expected = `body:${createHash("sha256").update(body).digest("hex")}`;
    expect(whazingDeliveryId(null, body)).toBe(expected);
  });
});

// ── normalizeWhazingEvent ─────────────────────────────────────────────────────

describe("normalizeWhazingEvent", () => {
  test("returns null for null, primitives, and eventless payloads", () => {
    expect(normalizeWhazingEvent(null)).toBeNull();
    expect(normalizeWhazingEvent(42)).toBeNull();
    expect(normalizeWhazingEvent({ noEvent: true })).toBeNull();
    expect(normalizeWhazingEvent("string")).toBeNull();
  });

  test("normalizes a message_received payload with top-level fields", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 55,
      queueId: 3,
      assignedUserId: null,
      status: "pending",
      contact: { id: 10, name: "Alice", waId: "5511999990000" },
      message: {
        id: "msg-abc",
        body: "Olá",
        fromMe: false,
        isAutomation: false,
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.event).toBe("message_received");
    expect(ev?.ticketId).toBe(55);
    expect(ev?.queueId).toBe(3);
    expect(ev?.assignedUserId).toBeNull();
    expect(ev?.status).toBe("pending");
    expect(ev?.contact?.id).toBe(10);
    expect(ev?.contact?.whatsappId).toBe("5511999990000");
    expect(ev?.message?.id).toBe("msg-abc");
    expect(ev?.message?.body).toBe("Olá");
    expect(ev?.message?.fromMe).toBe(false);
  });

  test("normalizes fields nested under a ticket object", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticket: { id: 77, queueId: 2, status: "open", assignedUserId: null },
      contact: { id: 20, waId: "5521900001111" },
      message: { id: "msg-xyz", body: "Hi", fromMe: false },
    });
    expect(ev?.ticketId).toBe(77);
    expect(ev?.queueId).toBe(2);
    expect(ev?.status).toBe("open");
  });

  test("coerces string ticketId/queueId to number", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: "99",
      queueId: "4",
      status: "pending",
      message: { body: "test", fromMe: false },
    });
    expect(ev?.ticketId).toBe(99);
    expect(ev?.queueId).toBe(4);
  });

  test("normalizes whatsappId from waId, whatsappId, or jid fields", () => {
    const waId = normalizeWhazingEvent({
      event: "x",
      ticketId: 1,
      contact: { waId: "5500000001" },
      message: { fromMe: false },
    });
    expect(waId?.contact?.whatsappId).toBe("5500000001");

    const jid = normalizeWhazingEvent({
      event: "x",
      ticketId: 1,
      contact: { jid: "5500000002@s.whatsapp.net" },
      message: { fromMe: false },
    });
    expect(jid?.contact?.whatsappId).toBe("5500000002@s.whatsapp.net");
  });

  test("normalizes message body from text or body field", () => {
    const fromText = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: { text: "from text", fromMe: false },
    });
    expect(fromText?.message?.body).toBe("from text");

    const fromBody = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: { body: "from body", fromMe: false },
    });
    expect(fromBody?.message?.body).toBe("from body");
  });

  test("detects automation messages by typebotId / integrationId", () => {
    const typebot = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: { body: "bot", fromMe: false, typebotId: "tb-1" },
    });
    expect(typebot?.message?.isAutomation).toBe(true);

    const integration = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: { body: "int", fromMe: false, integrationId: "int-1" },
    });
    expect(integration?.message?.isAutomation).toBe(true);
  });

  test("sets status null for unknown status values", () => {
    const ev = normalizeWhazingEvent({
      event: "x",
      ticketId: 1,
      status: "archived",
      message: { fromMe: false },
    });
    expect(ev?.status).toBeNull();
  });

  test("normalizes attachments array", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: {
        fromMe: false,
        body: null,
        attachments: [
          { id: "att-1", mediaType: "audio", url: "https://cdn.whazing.com/audio.ogg" },
        ],
      },
    });
    expect(ev?.message?.attachments).toHaveLength(1);
    expect(ev?.message?.attachments[0].mediaType).toBe("audio");
    expect(ev?.message?.attachments[0].mediaUrl).toBe("https://cdn.whazing.com/audio.ogg");
  });
});

// ── isNewIncomingMessage ──────────────────────────────────────────────────────

describe("isNewIncomingMessage", () => {
  const makeEv = (over: Record<string, unknown>) =>
    normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      status: "pending",
      message: { id: "m", body: "hello", fromMe: false },
      ...over,
    })!;

  test("returns true for a well-formed inbound customer message", () => {
    expect(isNewIncomingMessage(makeEv({}))).toBe(true);
  });

  test("returns false when event type is not message_received", () => {
    const ev = normalizeWhazingEvent({
      event: "ticket_status_changed",
      ticketId: 1,
      status: "closed",
      message: { body: "done", fromMe: false },
    })!;
    expect(isNewIncomingMessage(ev)).toBe(false);
  });

  test("returns false when ticketId is null", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      status: "pending",
      message: { body: "hi", fromMe: false },
    })!;
    expect(isNewIncomingMessage(ev)).toBe(false);
  });

  test("returns false when body is empty or whitespace", () => {
    const noBody = makeEv({ message: { body: "", fromMe: false } });
    expect(isNewIncomingMessage(noBody)).toBe(false);

    const ws = makeEv({ message: { body: "   ", fromMe: false } });
    expect(isNewIncomingMessage(ws)).toBe(false);
  });

  test("returns false when message is null", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      status: "pending",
    })!;
    expect(isNewIncomingMessage(ev)).toBe(false);
  });
});

// ── shouldWhazingBotHandle ────────────────────────────────────────────────────

describe("shouldWhazingBotHandle", () => {
  const open = (over: Record<string, unknown>) =>
    normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      assignedUserId: null,
      status: "pending",
      message: { body: "hi", fromMe: false },
      ...over,
    })!;

  test("returns true for an unassigned pending incoming message", () => {
    expect(shouldWhazingBotHandle(open({}))).toBe(true);
  });

  test("returns false when fromMe is true (loop prevention)", () => {
    expect(shouldWhazingBotHandle(open({ message: { body: "echo", fromMe: true } }))).toBe(false);
  });

  test("returns false when isAutomation is true", () => {
    const ev = open({
      message: { body: "bot", fromMe: false, typebotId: "t1" },
    });
    expect(shouldWhazingBotHandle(ev)).toBe(false);
  });

  test("returns false when a human user is assigned", () => {
    expect(shouldWhazingBotHandle(open({ assignedUserId: 42 }))).toBe(false);
  });

  test("returns false when ticket status is closed", () => {
    expect(shouldWhazingBotHandle(open({ status: "closed" }))).toBe(false);
  });

  test("returns false when message is null", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      assignedUserId: null,
      status: "pending",
    })!;
    expect(shouldWhazingBotHandle(ev)).toBe(false);
  });
});
