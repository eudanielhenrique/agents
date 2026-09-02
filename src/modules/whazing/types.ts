// Whazing webhook payload shapes (the subset we consume) and our normalized event.
//
// Whazing delivers events via a channel webhook (configured per instance). Key differences
// from Chatwoot: no native Agent Bot concept — we consume the webhook as a channel integration.
// The "conversation" is a Ticket; the "inbox" is a Queue.
//
// Sender classification:
//   fromMe == false + no assignedUserId → customer message
//   fromMe == false + assignedUserId   → human agent message (should not be replied to)
//   fromMe == true                     → message we sent (must ignore to prevent loops)
//   typebotId / integrationId present  → automation-originated (ignore)

export type WhazingTicketStatus = "open" | "pending" | "closed";

export const WHAZING_HANDLED_EVENTS = [
  "message_received",
  "message_sent",
  "ticket_status_changed",
  "ticket_assigned",
  "ticket_created",
] as const;

export type WhazingHandledEvent = (typeof WHAZING_HANDLED_EVENTS)[number];

export interface NormalizedWhazingAttachment {
  id: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  fileName: string | null;
}

export interface NormalizedWhazingMessage {
  id: string | null;
  body: string | null;
  // true when the message was sent by our API or the operator (not the customer).
  fromMe: boolean;
  // true when originated by a Typebot / integration automation (never reply to these).
  isAutomation: boolean;
  attachments: NormalizedWhazingAttachment[];
  timestamp: number | null;
}

export interface NormalizedWhazingContact {
  id: number | null;
  name: string | null;
  phone: string | null;
  // WhatsApp LID (newer API format); used as channel identifier in the thread key.
  whatsappId: string | null;
}

// A WhatsApp "click-to-WhatsApp ad" (ctwa_ad) entry signal, read from the message's contextInfo
// (buried in the webhook's raw `dataJson` blob — a different, deeper structure than the flat
// message fields, so it is parsed separately from the rest of normalizeWhazingEvent).
export interface WhazingCampaignSignal {
  ctwaClid: string | null;
  sourceId: string | null;
  sourceApp: string | null;
  // The ad creative's own title/body (Meta's externalAdReply) — what the customer actually saw
  // before tapping "send message", so the agent can ground its opening reply in the specific offer
  // instead of asking the customer to repeat it.
  adTitle: string | null;
  adBody: string | null;
}

export interface NormalizedWhazingEvent {
  event: WhazingHandledEvent | string;
  ticketId: number | null;
  queueId: number | null;
  // ID of the assigned human agent; non-null means a human owns this ticket — bot must not reply.
  assignedUserId: number | null;
  status: WhazingTicketStatus | null;
  // How an outbound (fromMe) message was sent — "bot"/"smartreception" mark our own/Whazing's
  // automated sends; anything else (including absent) is a human typing directly in Whazing.
  sendType: string | null;
  // Non-null when this inbound message carries a click-to-WhatsApp-ad entry signal.
  campaignSignal: WhazingCampaignSignal | null;
  contact: NormalizedWhazingContact | null;
  message: NormalizedWhazingMessage | null;
}
