import { createHash } from "node:crypto";
import { extractTagValues, hasIgnoredTag } from "./tags";
import type {
  NormalizedWhazingAttachment,
  NormalizedWhazingContact,
  NormalizedWhazingEvent,
  NormalizedWhazingMessage,
  WhazingCampaignSignal,
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

// A click-to-WhatsApp-ad (ctwa_ad) entry signal lives in contextInfo (inside the raw dataJson
// WhatsApp protocol message) OR in Whazing's ticket referral fields (metaReferralJson, metaAdName,
// leadSource = "META_AD"). Both sources are checked and merged so no ad context is missed.
export function extractCampaignSignal(
  dataJson?: unknown,
  ticket?: Record<string, unknown> | null,
  root?: Record<string, unknown>,
): WhazingCampaignSignal | null {
  let signalFromDataJson: WhazingCampaignSignal | null = null;
  if (typeof dataJson === "string" && dataJson !== "") {
    try {
      const raw = JSON.parse(dataJson);
      const message =
        raw && typeof raw === "object"
          ? ((raw as Record<string, unknown>).message as
              | Record<string, unknown>
              | undefined)
          : undefined;
      if (message) {
        const variants = [
          "extendedTextMessage",
          "imageMessage",
          "videoMessage",
          "documentMessage",
          "content",
        ] as const;
        let contextInfo: Record<string, unknown> | undefined;
        for (const key of variants) {
          const variant = message[key];
          if (variant && typeof variant === "object") {
            const ci = (variant as Record<string, unknown>).contextInfo;
            if (ci && typeof ci === "object") {
              contextInfo = ci as Record<string, unknown>;
              break;
            }
          }
        }
        if (contextInfo) {
          const adReply = contextInfo.externalAdReply;
          const ad =
            adReply && typeof adReply === "object"
              ? (adReply as Record<string, unknown>)
              : {};
          const ctwaClid = str(ad.ctwaClid);
          const isCtwaAd =
            str(contextInfo.entryPointConversionSource) === "ctwa_ad";
          if (isCtwaAd || ctwaClid) {
            signalFromDataJson = {
              ctwaClid,
              sourceId: str(ad.sourceId) ?? str(ad.sourceID),
              sourceApp: str(ad.sourceApp),
              adTitle: str(ad.title),
              adBody: str(ad.body),
            };
          }
        }
      }
    } catch {}
  }

  // Check Whazing's ticket / root metaReferralJson and campaign fields
  let signalFromReferral: WhazingCampaignSignal | null = null;
  const rawReferral = ticket?.metaReferralJson ?? root?.metaReferralJson;
  let ref: Record<string, unknown> | null = null;
  if (typeof rawReferral === "string" && rawReferral.trim() !== "") {
    try {
      ref = JSON.parse(rawReferral);
    } catch {}
  } else if (rawReferral && typeof rawReferral === "object") {
    ref = rawReferral as Record<string, unknown>;
  }

  const leadSource = str(ticket?.leadSource) ?? str(root?.leadSource);
  const metaAdName = str(ticket?.metaAdName) ?? str(root?.metaAdName);
  const metaCampaignName =
    str(ticket?.metaCampaignName) ?? str(root?.metaCampaignName);

  if (ref || leadSource === "META_AD" || metaAdName || metaCampaignName) {
    const ctwaClid = str(ref?.ctwaClid);
    const sourceId = str(ref?.adId) ?? str(ref?.sourceId) ?? str(ref?.sourceID);
    const sourceApp =
      str(ref?.provider) ??
      str(ref?.sourceType) ??
      str(ref?.sourceApp) ??
      (leadSource === "META_AD" ? "Meta" : null);
    const adTitle = str(ref?.title) ?? metaAdName ?? metaCampaignName;
    const adBody = str(ref?.body);
    const thumbnailUrl = str(ref?.thumbnailUrl);

    if (ctwaClid || sourceId || adTitle || adBody || leadSource === "META_AD") {
      signalFromReferral = {
        ctwaClid,
        sourceId,
        sourceApp,
        adTitle,
        adBody,
        thumbnailUrl,
      };
    }
  }

  if (!signalFromDataJson && !signalFromReferral) return null;
  if (!signalFromDataJson) return signalFromReferral;
  if (!signalFromReferral) return signalFromDataJson;

  return {
    ctwaClid:
      signalFromDataJson.ctwaClid ?? signalFromReferral.ctwaClid ?? null,
    sourceId:
      signalFromDataJson.sourceId ?? signalFromReferral.sourceId ?? null,
    sourceApp:
      signalFromDataJson.sourceApp ?? signalFromReferral.sourceApp ?? null,
    adTitle: signalFromDataJson.adTitle ?? signalFromReferral.adTitle ?? null,
    adBody: signalFromDataJson.adBody ?? signalFromReferral.adBody ?? null,
    thumbnailUrl: signalFromReferral.thumbnailUrl ?? null,
  };
}

function coerceNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeContact(raw: unknown): NormalizedWhazingContact | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const tags = extractTagValues(c.tags);
  return {
    id: coerceNum(c.id),
    name: str(c.name),
    phone: str(c.phone) ?? str(c.phoneNumber),
    // `lid` is the field name Whazing's own contact API and webhook payloads actually use for the
    // WhatsApp LID (confirmed live, e.g. "126409561346102@lid") — waId/whatsappId/jid were the
    // guessed field names this originally shipped with and have never matched a real payload,
    // which silently broke contact-based thread continuity (every production thread fell back to
    // the per-ticket key; a returning contact's new ticket never recalled the prior conversation).
    // Keep the old names as a fallback in case another Whazing payload shape ever uses them.
    whatsappId: str(c.lid) ?? str(c.waId) ?? str(c.whatsappId) ?? str(c.jid),
    tags: tags.length > 0 ? tags : undefined,
  };
}

function normalizeAttachment(raw: unknown): NormalizedWhazingAttachment {
  const a =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let mediaUrl = str(a.mediaUrl) ?? str(a.url);
  if (!mediaUrl && typeof a.base64 === "string" && a.base64.trim() !== "") {
    const b64 = a.base64.trim();
    mediaUrl = b64.startsWith("data:")
      ? b64
      : `data:${str(a.mimeType) ?? "application/octet-stream"};base64,${b64}`;
  }
  return {
    id: str(a.id),
    mediaType: str(a.mediaType) ?? str(a.type),
    mediaUrl,
    mimeType: str(a.mimeType),
    fileName: str(a.fileName) ?? str(a.name),
  };
}

// Extracts the selected button/list option ID from WhatsApp interactive messages.
// Whazing/Uazapi surfaces this in message.buttonOrListid, message.content.selectedID, or dataJson.
function extractInteractiveChoice(
  m: Record<string, unknown>,
  dataJson?: unknown,
): string | null {
  const content =
    m.content && typeof m.content === "object"
      ? (m.content as Record<string, unknown>)
      : null;
  const direct =
    str(m.buttonOrListid) ??
    str(content?.selectedID) ??
    str(content?.buttonOrListid) ??
    str(m.selectedButtonId);
  if (direct) return direct;

  if (typeof dataJson === "string" && dataJson !== "") {
    try {
      const parsed = JSON.parse(dataJson);
      const msg = parsed?.message;
      const parsedContent = msg?.content;
      return (
        str(msg?.buttonOrListid) ??
        str(parsedContent?.selectedID) ??
        str(parsedContent?.buttonOrListid) ??
        null
      );
    } catch {
      return null;
    }
  }
  return null;
}

function resolveMessageBody(
  rawBody: string | null,
  interactiveChoice: string | null,
): string | null {
  if (!interactiveChoice) return rawBody;
  if (!rawBody) return interactiveChoice;
  if (rawBody.trim().toLowerCase() === interactiveChoice.trim().toLowerCase()) {
    return rawBody;
  }

  // If interactiveChoice is already a full sentence that includes rawBody, prefer it
  if (interactiveChoice.toLowerCase().includes(rawBody.toLowerCase())) {
    return interactiveChoice;
  }

  // If rawBody is generic (e.g. "Quero esse modelo") and interactiveChoice carries the specific selection
  // (e.g. "Quero reservar o bolo BK-310" or "BK-310"), combine them so the agent knows the selection.
  return `${rawBody} (${interactiveChoice})`;
}

function normalizeMessage(
  raw: unknown,
  dataJson?: unknown,
): NormalizedWhazingMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const rawAttachments = Array.isArray(m.attachments) ? m.attachments : [];
  const rawBody = str(m.body) ?? str(m.text) ?? str(m.vote);
  const interactiveChoice = extractInteractiveChoice(m, dataJson);
  const body = resolveMessageBody(rawBody, interactiveChoice);

  return {
    id: str(m.id) ?? str(m.messageId),
    body,
    fromMe: m.fromMe === true || m.fromMe === "true",
    // Typebot or integration automation — never reply to these
    isAutomation: !!(m.typebotId ?? m.integrationId),
    attachments: rawAttachments.map(normalizeAttachment),
    timestamp: num(m.timestamp) ?? coerceNum(m.createdAt),
  };
}

// Normalizes a raw Whazing webhook payload into our internal shape.
// Supports two shapes:
//   (A) Standard: { event, message: {...}, ticket: {...}, contact: {...} }
//   (B) Whazing flat: { messageId, messageBody, fromMe, ticket: {...}, contact: {...} }
//       — no `event` field; message data lives at the top level.
// Returns null for unsupported or malformed payloads (no recognizable event).
export function normalizeWhazingEvent(
  raw: unknown,
): NormalizedWhazingEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Shape (A): explicit event field.
  // Shape (B): Whazing flat payload — infer "message_received" from presence of messageId/messageBody.
  // The channel webhook also delivers ticket-lifecycle events (NewTicket, TransferTicket, ClosedTicket,
  // NewTicketUserCreate) as flat payloads carrying their own `Type` + a `messageBody` (e.g. a transfer
  // note) but NO `messageId` — without excluding them here, a non-empty messageBody would make one look
  // like a real incoming message. Real message payloads never carry `Type` (see Whazing's webhook docs),
  // so its presence is the reliable discriminator.
  let event = str(r.event);
  if (!event) {
    const isLifecycleEvent = str(r.Type) != null;
    if (!isLifecycleEvent && (r.messageId != null || r.messageBody != null)) {
      event = "message_received";
    } else {
      return null;
    }
  }

  // Ticket nested object (present in both shapes).
  const ticket =
    r.ticket && typeof r.ticket === "object"
      ? (r.ticket as Record<string, unknown>)
      : null;

  const ticketId =
    coerceNum(r.ticketId) ?? coerceNum(ticket?.id) ?? coerceNum(r.id);
  const queueId = coerceNum(r.queueId) ?? coerceNum(ticket?.queueId);
  const sendType = str(r.sendType);
  const campaignSignal = extractCampaignSignal(r.dataJson);

  // assignedUserId: prefer explicit fields; ignore `user` object (may be the bot itself).
  const assignedUserId =
    coerceNum(r.assignedUserId) ?? coerceNum(ticket?.assignedUserId) ?? null;

  // Ticket status from nested ticket first, fall back to top-level (which may be message status).
  const rawStatus = str(ticket?.status) ?? str(r.status);
  const status: WhazingTicketStatus | null =
    rawStatus === "open" || rawStatus === "pending" || rawStatus === "closed"
      ? rawStatus
      : null;

  // Contact from top-level or nested in ticket.
  const rawContact = r.contact ?? ticket?.contact;
  const contact = normalizeContact(rawContact);

  // Shape (A): message in r.message.
  // Shape (B): message fields at root — messageId, messageBody, fromMe, mediaType, mediaUrl.
  let message: NormalizedWhazingMessage | null;
  if (r.message && typeof r.message === "object") {
    message = normalizeMessage(r.message, r.dataJson);
  } else if (r.messageId != null || r.messageBody != null) {
    const attachments: NormalizedWhazingAttachment[] = [];
    // `mediaType` classifies EVERY message ("chat" for plain text, "audio" for voice, ...) — it is
    // never absent, so gating on its truthiness treated every ordinary text message as an
    // attachment. The actual "there is a file" signal is a real media URL/payload.
    if (r.mediaUrl || r.mediaBase64) {
      attachments.push({
        id: null,
        mediaType: str(r.mediaType),
        mediaUrl: str(r.mediaUrl) ?? str(r.mediaBase64 ? "data:" : null),
        mimeType: null,
        fileName: null,
      });
    }
    const interactiveChoice =
      str(r.buttonOrListid) ??
      str(r.selectedButtonId) ??
      extractInteractiveChoice({}, r.dataJson);
    const rawBody = str(r.messageBody) ?? str(r.text) ?? str(r.vote);
    const body = resolveMessageBody(rawBody, interactiveChoice);

    message = {
      id: str(r.messageId),
      body,
      fromMe: r.fromMe === true || r.fromMe === "true",
      isAutomation: false,
      attachments,
      timestamp: coerceNum(r.timestamp),
    };
  } else {
    message = null;
  }

  const ticketContact = ticket?.contact as Record<string, unknown> | undefined;
  const rootContact = r.contact as Record<string, unknown> | undefined;
  const rawTags = [
    ...extractTagValues(r.tags),
    ...extractTagValues(ticket?.tags),
    ...extractTagValues(ticketContact?.tags),
    ...extractTagValues(rootContact?.tags),
  ];
  const tags = Array.from(new Set(rawTags));

  return {
    event,
    ticketId,
    queueId,
    assignedUserId,
    status,
    sendType,
    campaignSignal,
    contact,
    message,
    tags: tags.length > 0 ? tags : undefined,
  };
}

// Returns true when the event is a new message from the customer that the bot should evaluate.
// Accepts audio-only messages (body empty but attachments present) so voice notes reach the runtime.
export function isNewIncomingMessage(event: NormalizedWhazingEvent): boolean {
  if (event.event !== "message_received") return false;
  if (event.ticketId == null) return false;
  const msg = event.message;
  if (!msg) return false;
  return !!msg.body?.trim() || msg.attachments.length > 0;
}

// Returns true when the bot should handle this event (not skip it).
// A message that passes this gate gets handed to the agent runtime.
//
// Double-gate design (mirrors the Chatwoot shouldBotHandle):
//   - fromMe: ignore messages we sent (loop prevention)
//   - isAutomation: ignore Typebot / integration messages
//   - assignedUserId: a human owns the ticket — bot must stay silent
//   - status: closed tickets are done; pending is still ours
//   - ignoredTags: tickets or contacts with any ignored tag are ignored
export function shouldWhazingBotHandle(
  event: NormalizedWhazingEvent,
  ignoredTags?: Array<number | string>,
): boolean {
  const msg = event.message;
  if (!msg) return false;
  if (msg.fromMe) return false;
  if (msg.isAutomation) return false;
  if (event.assignedUserId != null) return false;
  if (event.status === "closed") return false;
  if (ignoredTags && ignoredTags.length > 0) {
    const candidateTags = [
      ...(event.tags ?? []),
      ...(event.contact?.tags ?? []),
    ];
    if (hasIgnoredTag(candidateTags, ignoredTags)) return false;
  }
  return true;
}

// A human typed directly in Whazing (not through our API, not Whazing's own automation) — the
// ticket's queue hasn't necessarily caught up yet (that move happens out of band, in n8n), so this
// is the earliest and only reliable local signal that a human just took over. "bot"/"smartreception"
// are the sendType values Whazing stamps on messages sent through an API key or its own automation;
// anything else (including missing) is a human agent's app/console.
export function isManualHumanReply(event: NormalizedWhazingEvent): boolean {
  const msg = event.message;
  if (!msg?.fromMe) return false;
  if (msg.isAutomation) return false;
  if (event.sendType && /^(bot|smartreception)$/.test(event.sendType))
    return false;
  return true;
}

export type WhazingControlCommand = "teste" | "reset";

// Mirrors chatwoot/normalize.ts's controlCommand — pure text match, no Chatwoot type involved.
export function whazingControlCommand(
  body: string | null | undefined,
): WhazingControlCommand | null {
  const lc = (body ?? "").trim().toLowerCase();
  if (lc === "/teste") return "teste";
  if (lc === "/reset") return "reset";
  return null;
}
