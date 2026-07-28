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

export interface NormalizedWhazingEvent {
  event: WhazingHandledEvent | string;
  ticketId: number | null;
  queueId: number | null;
  // ID of the assigned human agent; non-null means a human owns this ticket — bot must not reply.
  assignedUserId: number | null;
  status: WhazingTicketStatus | null;
  contact: NormalizedWhazingContact | null;
  message: NormalizedWhazingMessage | null;
}
