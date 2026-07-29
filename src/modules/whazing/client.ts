import { randomUUID } from "node:crypto";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { InboxReplyClient } from "@/lib/transport/inbox-client";

// Whazing API client. Implements InboxReplyClient for the shared agent runtime.
//
// All write operations use POST to the base URL ({{base_url}}) or specific sub-paths.
// Auth: Bearer JWT per instance (WhazingInstance.apiKey, decrypted at load time).
// SSRF: baseUrl is validated once at construction (assertSafeOutboundUrl).
//
// Endpoint map (from official Postman collection):
//   POST {base}            — send text/media message (body/ticketId/number/externalKey)
//   GET  {base}/ticket/:id — list messages for ticket
//   POST {base}/updateticketinfo — update ticket status/user/queue
//   POST {base}/updatequeue      — assign to queue
//   POST {base}/updatetag        — set contact tags (array of tag IDs)
//   POST {base}/showticket       — get ticket by number
//   POST {base}/updatecontact    — update contact fields
//   GET  {base}/kanbanpro/boards               — list boards
//   GET  {base}/kanbanpro/boards/:id/columns   — list columns of a board
//   POST {base}/kanbanpro/card                 — create or move card (action: create_or_move)
//   PUT  {base}/kanbanpro/card/:id             — update card fields
//   GET  {base}/kanbanpro/contact/:id/cards    — get cards for a contact
//   POST {base}/apiplus         — interactive messages (button/list/cta_url/location request/
//                                  dynamic button/carousel), keyed by contents.type
//   POST {base}/pixbutton       — send a "copy PIX key" button
//   POST {base}/requestpayment  — send a payment-request card (amount + PIX or payment link)
//
// NOTE: the Postman collection's /apiplus, /pixbutton, /requestpayment examples all address the
// ticket via top-level "number" (phone number). The base send-text endpoint documents "ticketId" as
// an accepted alternative in the same top-level position (see "SendMessageAPIText ticketId" in the
// collection) — this file uses ticketId there for consistency with the rest of this client, but that
// substitution is NOT literally shown for these three routes. Verify against a live instance.

const REQUEST_TIMEOUT_MS = 15_000;

export interface WhazingReplyButton {
  id: string;
  title: string;
}

export interface WhazingListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhazingListSection {
  title: string;
  rows: WhazingListRow[];
}

export type WhazingDynamicChoice =
  | { type: "reply"; id: string; displayText: string }
  | { type: "copy"; displayText: string; copyText: string }
  | { type: "call"; displayText: string; phoneNumber: string }
  | { type: "url"; displayText: string; url: string };

export interface WhazingCarouselItem {
  text: string;
  // Public image URL. The Postman examples embed base64 data URIs here instead — untested whether
  // a plain URL is also accepted; verify against a live instance.
  image: string;
  choices: WhazingDynamicChoice[];
}

export type WhazingPixType = "CPF" | "CNPJ" | "PHONE" | "EMAIL" | "EVP";

export class WhazingApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(status: number, endpoint: string) {
    super(`Whazing API ${status} for ${endpoint}`);
    this.name = "WhazingApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export interface WhazingClientConfig {
  baseUrl: string;
  apiKey: string;
}

export class WhazingClient implements InboxReplyClient {
  private readonly apiBase: string;

  constructor(
    private readonly config: WhazingClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // baseUrl is the full External API root (e.g. https://host/v1/api/external/UUID).
    // Sending a message is a POST to this root URL directly (no sub-path).
    this.apiBase = config.baseUrl.replace(/\/+$/, "");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${this.apiBase}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new WhazingApiError(res.status, `${method} ${url}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── InboxReplyClient (shared runtime interface) ──

  // Send text message to an existing ticket.
  // Whazing uses "body" (not "text") and requires an externalKey for idempotency.
  sendMessage(ticketId: number, text: string): Promise<unknown> {
    return this.request("POST", "", {
      body: text,
      ticketId,
      externalKey: randomUUID(),
    });
  }

  // Whazing has no native private-note concept — send as a regular message.
  sendPrivateNote(ticketId: number, text: string): Promise<unknown> {
    return this.sendMessage(ticketId, text);
  }

  async sendAudioMessage(
    ticketId: number,
    audio: ArrayBuffer,
    fileName: string,
    mime: string,
    opts?: { transcribedText?: string },
  ): Promise<unknown> {
    const form = new FormData();
    form.append("media", new Blob([audio], { type: mime }), fileName);
    form.append("body", opts?.transcribedText ?? "");
    form.append("ticketId", String(ticketId));
    form.append("externalKey", randomUUID());
    const url = this.apiBase;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new WhazingApiError(res.status, `POST ${url} (audio)`);
    return null;
  }

  // Whazing does not expose a typing indicator API — best-effort no-op.
  toggleTyping(_ticketId: number, _on: boolean): Promise<unknown> {
    return Promise.resolve(null);
  }

  // ── Ticket operations ──

  // List messages for a ticket (GET /ticket/:id).
  getTicket(ticketId: number): Promise<unknown> {
    return this.request("GET", `/ticket/${ticketId}`);
  }

  // Assign to a human user via /updateticketinfo.
  assignTicketToUser(ticketId: number, userId: number): Promise<unknown> {
    return this.request("POST", "/updateticketinfo", { ticketId, userId });
  }

  // Assign to a queue via /updatequeue.
  assignTicketToQueue(ticketId: number, queueId: number): Promise<unknown> {
    return this.request("POST", "/updatequeue", { ticketId, queueId });
  }

  // Close ticket via /updateticketinfo with status "closed".
  closeTicket(ticketId: number): Promise<unknown> {
    return this.request("POST", "/updateticketinfo", {
      ticketId,
      status: "closed",
    });
  }

  // Set tags on a contact. Whazing tags are numeric IDs; we pass string tags as-is
  // and Whazing resolves them. Use ticketId instead of contactId when available.
  setContactTags(contactId: number, tags: string[]): Promise<unknown> {
    return this.request("POST", "/updatetag", { contactId, tags });
  }

  // Download a media file from a Whazing URL using the Bearer token.
  // Used by getWhazingConversationMedia to proxy attachments through our origin.
  async downloadMedia(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new WhazingApiError(res.status, `GET ${url} (media)`);
    const bytes = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return { bytes, contentType };
  }

  // ── Kanban Pro operations ──

  // List all boards visible to this instance.
  kanbanGetBoards(): Promise<unknown> {
    return this.request("GET", "/kanbanpro/boards");
  }

  // List columns of a board (for resolving column names to IDs).
  kanbanGetColumns(boardId: number): Promise<unknown> {
    return this.request("GET", `/kanbanpro/boards/${boardId}/columns`);
  }

  // Create or move a card in the funnel. action "create_or_move" creates the card if the
  // contact has none on the board, otherwise moves the existing card to columnId.
  kanbanCreateOrMove(params: {
    boardId: number;
    columnId: number;
    contactId: number;
    note?: string;
    title?: string;
    priority?: "none" | "low" | "medium" | "high" | "urgent";
  }): Promise<unknown> {
    return this.request("POST", "/kanbanpro/card", {
      ...params,
      action: "create_or_move",
    });
  }

  // Get all kanban cards associated with a contact (across boards).
  kanbanGetContactCards(contactId: number): Promise<unknown> {
    return this.request("GET", `/kanbanpro/contact/${contactId}/cards`);
  }

  // Update fields of an existing card by its card ID.
  kanbanUpdateCard(
    cardId: number,
    fields: {
      title?: string;
      priority?: "none" | "low" | "medium" | "high" | "urgent";
      columnId?: number;
      note?: string;
      assigneeId?: number;
      dueDate?: string;
    },
  ): Promise<unknown> {
    return this.request("PUT", `/kanbanpro/card/${cardId}`, fields);
  }

  // ── API Plus — interactive messages ──

  // Up to 3 quick-reply buttons, optional image header.
  sendButtonMessage(
    ticketId: number,
    bodyText: string,
    buttons: WhazingReplyButton[],
    opts?: { headerImageUrl?: string },
  ): Promise<unknown> {
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
        ...(opts?.headerImageUrl
          ? { header: { type: "image", image: { link: opts.headerImageUrl } } }
          : {}),
      },
    });
  }

  // Sectioned picklist opened via a button (WhatsApp "list message").
  sendListMessage(
    ticketId: number,
    params: {
      headerText?: string;
      bodyText: string;
      buttonText: string;
      sections: WhazingListSection[];
    },
  ): Promise<unknown> {
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: {
        type: "list",
        ...(params.headerText ? { header: { type: "text", text: params.headerText } } : {}),
        body: { text: params.bodyText },
        action: { sections: params.sections, button: params.buttonText },
      },
    });
  }

  // Single link button ("cta_url"), optional text or image header.
  sendCtaUrlMessage(
    ticketId: number,
    params: {
      bodyText: string;
      displayText: string;
      url: string;
      headerText?: string;
      headerImageUrl?: string;
      footerText?: string;
    },
  ): Promise<unknown> {
    const header = params.headerImageUrl
      ? { type: "image", image: { link: params.headerImageUrl } }
      : params.headerText
        ? { type: "text", text: params.headerText }
        : undefined;
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: {
        type: "cta_url",
        ...(header ? { header } : {}),
        body: { text: params.bodyText },
        ...(params.footerText ? { footer: { text: params.footerText } } : {}),
        action: {
          name: "cta_url",
          parameters: { display_text: params.displayText, url: params.url },
        },
      },
    });
  }

  // Prompts the customer to share their location.
  sendLocationRequestMessage(ticketId: number, bodyText: string): Promise<unknown> {
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: {
        type: "location_request_message",
        body: { text: bodyText },
        action: { name: "send_location" },
      },
    });
  }

  // Richer button message: mixed reply/copy/call/url choices, optional image header.
  sendDynamicButtonMessage(
    ticketId: number,
    params: {
      text: string;
      footerText?: string;
      choices: WhazingDynamicChoice[];
      imageUrl?: string;
    },
  ): Promise<unknown> {
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: {
        type: "dinamic_button",
        text: params.text,
        ...(params.footerText ? { footerText: params.footerText } : {}),
        ...(params.imageUrl ? { imageUrl: params.imageUrl } : {}),
        choices: params.choices,
      },
    });
  }

  // Multi-card carousel, each card with its own image + reply/copy/call/url choices.
  sendCarouselMessage(
    ticketId: number,
    text: string,
    items: WhazingCarouselItem[],
  ): Promise<unknown> {
    return this.request("POST", "/apiplus", {
      ticketId,
      contents: { type: "carousel_button", text, items },
    });
  }

  // ── PIX ──

  // "Copy PIX key" button. pixKey/pixName/pixType should be operator-configured, never model-chosen
  // (see WhazingToolCtx.pixConfig / send_pix_button in tools.ts) — sending the wrong key means the
  // customer pays the wrong recipient.
  sendPixButtonMessage(
    ticketId: number,
    params: { pixKey: string; pixName: string; pixType: WhazingPixType },
  ): Promise<unknown> {
    return this.request("POST", "/pixbutton", {
      ticketId,
      contents: { type: "pixbutton", ...params },
    });
  }

  // Payment-request card: amount is required; either PIX fields or a pre-approved paymentLink.
  // boletoCode/itemName are supported by the API but not yet surfaced by any tool (MVP).
  sendPaymentRequestMessage(
    ticketId: number,
    params: {
      amount: number;
      text?: string;
      pixKey?: string;
      pixName?: string;
      pixType?: WhazingPixType;
      paymentLink?: string;
      title?: string;
      footer?: string;
      itemName?: string;
      boletoCode?: string;
    },
  ): Promise<unknown> {
    return this.request("POST", "/requestpayment", {
      ticketId,
      contents: { type: "requestpayment", ...params },
    });
  }
}

// SSRF-validated factory. Called by loadWhazingClient (instance.ts) after decrypting credentials.
// allowHttp: Whazing instances may run on HTTP (local or private networks).
export async function createWhazingClient(
  config: WhazingClientConfig,
): Promise<WhazingClient> {
  await assertSafeOutboundUrl(config.baseUrl, { allowHttp: true });
  return new WhazingClient(config);
}
