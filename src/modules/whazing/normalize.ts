import { createHash } from "node:crypto";
import type {
  NormalizedWhazingAttachment,
  NormalizedWhazingContact,
  NormalizedWhazingEvent,
  NormalizedWhazingMessage,
  WhazingTicketStatus,
} from "./types";

// Builds a deterministic delivery id for a message payload.
// Falls back to a body digest when the message has no id field.
export function whazingDeliveryId(
  messageId: string | null,
  rawBody: string,
): string {
  if (messageId) return messageId;
  return `body:${createHash("sha256").update(rawBody).digest("hex")}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function coerceNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeContact(
  raw: unknown,
): NormalizedWhazingContact | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  return {
    id: coerceNum(c.id),
    name: str(c.name),
    phone: str(c.phone) ?? str(c.phoneNumber),
    // waId is the WhatsApp LID used in the newer Whazing API
    whatsappId: str(c.waId) ?? str(c.whatsappId) ?? str(c.jid),
  };
}

function normalizeAttachment(raw: unknown): NormalizedWhazingAttachment {
  const a =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id: str(a.id),
    mediaType: str(a.mediaType) ?? str(a.type),
    mediaUrl: str(a.mediaUrl) ?? str(a.url),
    mimeType: str(a.mimeType),
    fileName: str(a.fileName) ?? str(a.name),
  };
}

function normalizeMessage(raw: unknown): NormalizedWhazingMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const rawAttachments = Array.isArray(m.attachments) ? m.attachments : [];
  return {
    id: str(m.id) ?? str(m.messageId),
    body: str(m.body) ?? str(m.text) ?? null,
    fromMe: m.fromMe === true || m.fromMe === "true",
    // Typebot or integration automation — never reply to these
    isAutomation: !!(m.typebotId ?? m.integrationId),
    attachments: rawAttachments.map(normalizeAttachment),
    timestamp: num(m.timestamp) ?? coerceNum(m.createdAt),
  };
}

// Normalizes a raw Whazing webhook payload into our internal shape.
// Returns null for unsupported or malformed payloads (unknown event type, missing ticketId).
export function normalizeWhazingEvent(
  raw: unknown,
): NormalizedWhazingEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const event = str(r.event);
  if (!event) return null;

  // Ticket fields may be top-level or nested under `ticket`
  const ticket =
    r.ticket && typeof r.ticket === "object"
      ? (r.ticket as Record<string, unknown>)
      : null;

  const ticketId =
    coerceNum(r.ticketId) ?? coerceNum(r.id) ?? coerceNum(ticket?.id);
  const queueId = coerceNum(r.queueId) ?? coerceNum(ticket?.queueId);
  const assignedUserId =
    coerceNum(r.assignedUserId) ?? coerceNum(ticket?.assignedUserId);

  const rawStatus = str(r.status) ?? str(ticket?.status);
  const status: WhazingTicketStatus | null =
    rawStatus === "open" || rawStatus === "pending" || rawStatus === "closed"
      ? rawStatus
      : null;

  // Contact may be top-level, inside ticket, or inside message
  const rawContact =
    r.contact ?? ticket?.contact ?? (r.message as Record<string, unknown> | undefined)?.contact;
  const contact = normalizeContact(rawContact);

  const message = normalizeMessage(r.message);

  return {
    event,
    ticketId,
    queueId,
    assignedUserId,
    status,
    contact,
    message,
  };
}

// Returns true when the event is a new message from the customer that the bot should evaluate.
// Accepts audio-only messages (body empty but attachments present) so voice notes reach the runtime.
export function isNewIncomingMessage(event: NormalizedWhazingEvent): boolean {
  if (event.event !== "message_received") return false;
  if (event.ticketId == null) return false;
  const msg = event.message;
  if (!msg) return false;
  return !!(msg.body?.trim()) || msg.attachments.length > 0;
}

// Returns true when the bot should handle this event (not skip it).
// A message that passes this gate gets handed to the agent runtime.
//
// Double-gate design (mirrors the Chatwoot shouldBotHandle):
//   - fromMe: ignore messages we sent (loop prevention)
//   - isAutomation: ignore Typebot / integration messages
//   - assignedUserId: a human owns the ticket — bot must stay silent
//   - status: closed tickets are done; pending is still ours
export function shouldWhazingBotHandle(event: NormalizedWhazingEvent): boolean {
  const msg = event.message;
  if (!msg) return false;
  if (msg.fromMe) return false;
  if (msg.isAutomation) return false;
  if (event.assignedUserId != null) return false;
  if (event.status === "closed") return false;
  return true;
}
