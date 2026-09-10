import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isManualHumanReply,
  isNewIncomingMessage,
  normalizeWhazingEvent,
  shouldWhazingBotHandle,
  whazingControlCommand,
  whazingDeliveryId,
} from "@/modules/whazing/normalize";
import { renderWhazingMessage } from "@/modules/whazing/render";
import {
  WHAZING_WEBHOOK_MOUNT,
  whazingWebhookUrl,
} from "@/modules/whazing/webhook-mount";

// ── control command parser (test-mode gate) ──────────────────────────────────

describe("whazingControlCommand", () => {
  test("recognizes /teste and /reset, case/whitespace insensitive", () => {
    expect(whazingControlCommand("/teste")).toBe("teste");
    expect(whazingControlCommand("/RESET")).toBe("reset");
    expect(whazingControlCommand("  /teste  ")).toBe("teste");
    expect(whazingControlCommand("/Teste")).toBe("teste");
  });

  test("anything else, including near-misses, is not a command", () => {
    expect(whazingControlCommand("teste")).toBeNull();
    expect(whazingControlCommand("/teste por favor")).toBeNull();
    expect(whazingControlCommand("")).toBeNull();
    expect(whazingControlCommand(null)).toBeNull();
    expect(whazingControlCommand(undefined)).toBeNull();
  });
});

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

  test("normalizes whatsappId from lid, waId, whatsappId, or jid fields", () => {
    // `lid` is the field Whazing's real payloads use (confirmed live) — checked first.
    const lid = normalizeWhazingEvent({
      event: "x",
      ticketId: 1,
      contact: { id: 10, lid: "126409561346102@lid" },
      message: { fromMe: false },
    });
    expect(lid?.contact?.whatsappId).toBe("126409561346102@lid");

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

  test("resolves interactive choice into message body when button is clicked", () => {
    // Direct buttonOrListid on message
    const direct = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: {
        body: "Quero esse modelo",
        buttonOrListid: "Quero reservar o bolo BK-310",
        fromMe: false,
      },
    });
    expect(direct?.message?.body).toBe(
      "Quero esse modelo (Quero reservar o bolo BK-310)",
    );

    // SelectedID from dataJson
    const fromDataJson = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: { body: "Quero esse modelo", fromMe: false },
      dataJson: JSON.stringify({
        message: {
          content: {
            selectedID: "BK-310",
            selectedDisplayText: "Quero esse modelo",
          },
        },
      }),
    });
    expect(fromDataJson?.message?.body).toBe("Quero esse modelo (BK-310)");

    // Identical text avoids duplicate repetition
    const identical = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: {
        body: "BK-310",
        buttonOrListid: "BK-310",
        fromMe: false,
      },
    });
    expect(identical?.message?.body).toBe("BK-310");
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

  test("ignores channel lifecycle events (Type field) even with a populated messageBody", () => {
    // Real payload shape per Whazing's channel webhook docs: TransferTicket/NewTicket/ClosedTicket/
    // NewTicketUserCreate carry `Type` + `messageBody` but no `messageId` — without the `Type` guard
    // this would be misread as a real incoming customer message.
    const transfer = normalizeWhazingEvent({
      Type: "TransferTicket",
      messageBody: "Ticket transferido para fila IA",
      ticket: { id: 1, status: "pending", queueId: 14 },
    });
    expect(transfer).toBeNull();

    const newTicket = normalizeWhazingEvent({
      Type: "NewTicket",
      messageBody: "Primeira mensagem do cliente",
      ticket: { id: 2, status: "pending", queueId: 39 },
    });
    expect(newTicket).toBeNull();
  });

  test("normalizes attachments array", () => {
    const ev = normalizeWhazingEvent({
      event: "message_received",
      ticketId: 1,
      message: {
        fromMe: false,
        body: null,
        attachments: [
          {
            id: "att-1",
            mediaType: "audio",
            url: "https://cdn.whazing.com/audio.ogg",
          },
        ],
      },
    });
    expect(ev?.message?.attachments).toHaveLength(1);
    expect(ev?.message?.attachments[0]?.mediaType).toBe("audio");
    expect(ev?.message?.attachments[0]?.mediaUrl).toBe(
      "https://cdn.whazing.com/audio.ogg",
    );
  });

  // Regression: Whazing's flat webhook shape (B) tags EVERY message with a `mediaType`
  // classification ("chat" for plain text, "audio" for voice, ...) — it is never absent. Gating
  // attachment creation on its truthiness turned every ordinary text message into a phantom
  // attachment, which renderWhazingMessage then rendered as "<mensagem-de-arquivo />", making the
  // agent hallucinate "recebi seu arquivo" on plain replies like "Obrigado".
  test("shape B plain text (mediaType classification, no media URL) has no attachments", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m1",
      messageBody: "Obrigado",
      fromMe: false,
      mediaType: "chat",
      mediaUrl: null,
      ticket: { id: 1, status: "pending" },
    });
    expect(ev?.message?.body).toBe("Obrigado");
    expect(ev?.message?.attachments).toHaveLength(0);
  });

  test("shape B real attachment (media URL present) is normalized", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m2",
      messageBody: null,
      fromMe: false,
      mediaType: "audio",
      mediaUrl: "https://cdn.whazing.com/audio.ogg",
      ticket: { id: 1, status: "pending" },
    });
    expect(ev?.message?.attachments).toHaveLength(1);
    expect(ev?.message?.attachments[0]?.mediaType).toBe("audio");
    expect(ev?.message?.attachments[0]?.mediaUrl).toBe(
      "https://cdn.whazing.com/audio.ogg",
    );
  });
});

// normalizeWhazingEvent returns null only for malformed payloads; every fixture below is
// well-formed by construction, so a null return here is a broken test, not a valid outcome.
function mustNormalize(
  payload: Record<string, unknown>,
): NonNullable<ReturnType<typeof normalizeWhazingEvent>> {
  const ev = normalizeWhazingEvent(payload);
  if (!ev)
    throw new Error(
      "normalizeWhazingEvent returned null for a well-formed fixture",
    );
  return ev;
}

// ── isNewIncomingMessage ──────────────────────────────────────────────────────

describe("isNewIncomingMessage", () => {
  const makeEv = (over: Record<string, unknown>) =>
    mustNormalize({
      event: "message_received",
      ticketId: 1,
      status: "pending",
      message: { id: "m", body: "hello", fromMe: false },
      ...over,
    });

  test("returns true for a well-formed inbound customer message", () => {
    expect(isNewIncomingMessage(makeEv({}))).toBe(true);
  });

  test("returns false when event type is not message_received", () => {
    const ev = mustNormalize({
      event: "ticket_status_changed",
      ticketId: 1,
      status: "closed",
      message: { body: "done", fromMe: false },
    });
    expect(isNewIncomingMessage(ev)).toBe(false);
  });

  test("returns false when ticketId is null", () => {
    const ev = mustNormalize({
      event: "message_received",
      status: "pending",
      message: { body: "hi", fromMe: false },
    });
    expect(isNewIncomingMessage(ev)).toBe(false);
  });

  test("returns false when body is empty or whitespace", () => {
    const noBody = makeEv({ message: { body: "", fromMe: false } });
    expect(isNewIncomingMessage(noBody)).toBe(false);

    const ws = makeEv({ message: { body: "   ", fromMe: false } });
    expect(isNewIncomingMessage(ws)).toBe(false);
  });

  test("returns false when message is null", () => {
    const ev = mustNormalize({
      event: "message_received",
      ticketId: 1,
      status: "pending",
    });
    expect(isNewIncomingMessage(ev)).toBe(false);
  });

  test("returns true for audio-only message (no body, has attachment)", () => {
    const ev = mustNormalize({
      event: "message_received",
      ticketId: 1,
      status: "pending",
      message: {
        fromMe: false,
        body: null,
        attachments: [
          { mediaType: "audio", url: "https://cdn.whazing.com/audio.ogg" },
        ],
      },
    });
    expect(isNewIncomingMessage(ev)).toBe(true);
  });
});

// ── shouldWhazingBotHandle ────────────────────────────────────────────────────

describe("shouldWhazingBotHandle", () => {
  const open = (over: Record<string, unknown>) =>
    mustNormalize({
      event: "message_received",
      ticketId: 1,
      assignedUserId: null,
      status: "pending",
      message: { body: "hi", fromMe: false },
      ...over,
    });

  test("returns true for an unassigned pending incoming message", () => {
    expect(shouldWhazingBotHandle(open({}))).toBe(true);
  });

  test("returns false when fromMe is true (loop prevention)", () => {
    expect(
      shouldWhazingBotHandle(open({ message: { body: "echo", fromMe: true } })),
    ).toBe(false);
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
    const ev = mustNormalize({
      event: "message_received",
      ticketId: 1,
      assignedUserId: null,
      status: "pending",
    });
    expect(shouldWhazingBotHandle(ev)).toBe(false);
  });
});

// ── isManualHumanReply ────────────────────────────────────────────────────────

describe("isManualHumanReply", () => {
  const outbound = (over: Record<string, unknown>) =>
    mustNormalize({
      event: "message_received",
      ticketId: 1,
      status: "pending",
      message: { body: "já te atendo", fromMe: true },
      ...over,
    });

  test("returns true for a human typing directly in Whazing (no sendType)", () => {
    expect(isManualHumanReply(outbound({}))).toBe(true);
  });

  test("returns true for a sendType that isn't bot/smartreception", () => {
    expect(isManualHumanReply(outbound({ sendType: "app" }))).toBe(true);
  });

  test("returns false for our own bot send", () => {
    expect(isManualHumanReply(outbound({ sendType: "bot" }))).toBe(false);
  });

  test("returns false for Whazing's own automation send", () => {
    expect(isManualHumanReply(outbound({ sendType: "smartreception" }))).toBe(
      false,
    );
  });

  test("returns false when fromMe is false (customer message)", () => {
    expect(
      isManualHumanReply(outbound({ message: { body: "oi", fromMe: false } })),
    ).toBe(false);
  });

  test("returns false when isAutomation is true (Typebot loop, not a person)", () => {
    const ev = outbound({
      message: { body: "bot", fromMe: true, typebotId: "t1" },
    });
    expect(isManualHumanReply(ev)).toBe(false);
  });
});

// ── campaignSignal (dataJson contextInfo extraction) ──────────────────────────
//
// Real production payload shapes (captured from a live n8n execution against this same webhook
// stream). The click_to_chat_link case is a real capture; the ctwa_ad case is synthesized from the
// same contract (n8n's "Analisar Sinal de Campanha" node) — no live ctwa_ad execution was available
// to capture at write time.

describe("normalizeWhazingEvent campaignSignal", () => {
  test("returns null for a click_to_chat_link entry (not a campaign)", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m1",
      messageBody: "Olá! Gostaria de mais informações",
      fromMe: false,
      ticket: { id: 1, status: "pending" },
      dataJson: JSON.stringify({
        message: {
          content: {
            text: "Olá! Gostaria de mais informações",
            contextInfo: {
              entryPointConversionSource: "click_to_chat_link",
              entryPointConversionDelaySeconds: 4,
            },
          },
        },
      }),
    });
    expect(ev?.campaignSignal).toBeNull();
  });

  test("returns null when dataJson is absent", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m2",
      messageBody: "oi",
      fromMe: false,
      ticket: { id: 1, status: "pending" },
    });
    expect(ev?.campaignSignal).toBeNull();
  });

  test("returns null when dataJson is malformed JSON", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m3",
      messageBody: "oi",
      fromMe: false,
      ticket: { id: 1, status: "pending" },
      dataJson: "{not valid json",
    });
    expect(ev?.campaignSignal).toBeNull();
  });

  test("extracts ctwaClid + source from a ctwa_ad entry (content variant)", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m4",
      messageBody: "Vi o anúncio de vocês",
      fromMe: false,
      ticket: { id: 1, status: "pending" },
      dataJson: JSON.stringify({
        message: {
          content: {
            text: "Vi o anúncio de vocês",
            contextInfo: {
              entryPointConversionSource: "ctwa_ad",
              externalAdReply: {
                ctwaClid: "AbCd1234",
                sourceId: "120210000000000",
                sourceApp: "AN",
                title: "Instituto Dr. Eduardo Jório",
                body: "Consultas de Medicina Integrativa",
              },
            },
          },
        },
      }),
    });
    expect(ev?.campaignSignal).toEqual({
      ctwaClid: "AbCd1234",
      sourceId: "120210000000000",
      sourceApp: "AN",
      adTitle: "Instituto Dr. Eduardo Jório",
      adBody: "Consultas de Medicina Integrativa",
    });
  });

  test("finds contextInfo under extendedTextMessage (another message-type variant)", () => {
    const ev = normalizeWhazingEvent({
      messageId: "m5",
      messageBody: "oi",
      fromMe: false,
      ticket: { id: 1, status: "pending" },
      dataJson: JSON.stringify({
        message: {
          extendedTextMessage: {
            contextInfo: {
              externalAdReply: { ctwaClid: "XyZ789" },
            },
          },
        },
      }),
    });
    expect(ev?.campaignSignal?.ctwaClid).toBe("XyZ789");
  });
});

describe("renderWhazingMessage campaign ad context", () => {
  test("prepends the ad offer when the event carries adTitle/adBody", () => {
    const rendered = renderWhazingMessage({
      event: "message_received",
      ticketId: 1,
      queueId: null,
      assignedUserId: null,
      status: "pending",
      sendType: null,
      campaignSignal: {
        ctwaClid: "AbCd1234",
        sourceId: "1",
        sourceApp: "AN",
        adTitle: "Instituto Dr. Eduardo Jório",
        adBody: "Consultas de Medicina Integrativa",
      },
      contact: null,
      message: {
        id: "m1",
        body: "Olá! Vi o anúncio de vocês",
        fromMe: false,
        isAutomation: false,
        attachments: [],
        timestamp: null,
      },
    });
    expect(rendered).toBe(
      '[Cliente veio de um anúncio: "Instituto Dr. Eduardo Jório — Consultas de Medicina Integrativa". Reconheça a oferta, não pergunte o que motivou o contato.]\nOlá! Vi o anúncio de vocês',
    );
  });

  test("omits the ad line when there is no campaign signal", () => {
    const rendered = renderWhazingMessage({
      event: "message_received",
      ticketId: 1,
      queueId: null,
      assignedUserId: null,
      status: "pending",
      sendType: null,
      campaignSignal: null,
      contact: null,
      message: {
        id: "m1",
        body: "oi",
        fromMe: false,
        isAutomation: false,
        attachments: [],
        timestamp: null,
      },
    });
    expect(rendered).toBe("oi");
  });
});
