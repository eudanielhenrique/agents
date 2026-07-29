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

const REQUEST_TIMEOUT_MS = 15_000;

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
}

// SSRF-validated factory. Called by loadWhazingClient (instance.ts) after decrypting credentials.
// allowHttp: Whazing instances may run on HTTP (local or private networks).
export async function createWhazingClient(
  config: WhazingClientConfig,
): Promise<WhazingClient> {
  await assertSafeOutboundUrl(config.baseUrl, { allowHttp: true });
  return new WhazingClient(config);
}
