import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { InboxReplyClient } from "@/lib/transport/inbox-client";

// Whazing API client. Implements InboxReplyClient for the shared agent runtime
// (deliverReply, runLoadedTurn) and provides additional methods for the webhook
// processor, response gate, handoff tools, and media ingestion.
//
// Auth: Bearer token per instance (WhazingInstance.apiKey, decrypted at load time).
// SSRF: baseUrl is validated once at construction (assertSafeOutboundUrl).

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
    // baseUrl already contains the full API root (e.g. https://host/v1/api/external/UUID).
    // Do NOT append /api — the caller supplies the complete base.
    this.apiBase = config.baseUrl.replace(/\/+$/, "");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
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
    if (!res.ok) throw new WhazingApiError(res.status, `${method} ${this.apiBase}${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── InboxReplyClient (shared runtime interface) ──

  sendMessage(ticketId: number, text: string): Promise<unknown> {
    return this.request("POST", `/messages/sendText`, {
      ticketId,
      text,
    });
  }

  // TODO: Whazing has no native private-note concept — send as internal note or agent message.
  // Confirm the exact endpoint once the spike (issue #14) validates the API shape.
  sendPrivateNote(ticketId: number, text: string): Promise<unknown> {
    return this.request("POST", `/tickets/${ticketId}/notes`, {
      body: text,
      private: true,
    });
  }

  // TODO: Confirm the Whazing audio send endpoint in the spike (#14).
  async sendAudioMessage(
    ticketId: number,
    audio: ArrayBuffer,
    fileName: string,
    mime: string,
    opts?: { transcribedText?: string },
  ): Promise<unknown> {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mime }), fileName);
    form.append("ticketId", String(ticketId));
    if (opts?.transcribedText) {
      form.append("transcribedText", opts.transcribedText);
    }
    const res = await this.fetchImpl(`${this.apiBase}/messages/sendAudio`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new WhazingApiError(res.status, "POST /messages/sendAudio");
    return null;
  }

  // Whazing does not expose a typing indicator API — best-effort no-op.
  toggleTyping(_ticketId: number, _on: boolean): Promise<unknown> {
    return Promise.resolve(null);
  }

  // ── Ticket operations (used by response gate, handoff, and native tools) ──

  getTicket(ticketId: number): Promise<unknown> {
    return this.request("GET", `/tickets/${ticketId}`);
  }

  // Assign to a human user (handoff).
  assignTicketToUser(ticketId: number, userId: number): Promise<unknown> {
    return this.request("PUT", `/tickets/${ticketId}`, { userId });
  }

  // Assign to a queue.
  assignTicketToQueue(ticketId: number, queueId: number): Promise<unknown> {
    return this.request("PUT", `/tickets/${ticketId}`, { queueId });
  }

  closeTicket(ticketId: number): Promise<unknown> {
    return this.request("PUT", `/tickets/${ticketId}`, { status: "closed" });
  }

  setContactTags(contactId: number, tags: string[]): Promise<unknown> {
    return this.request("PUT", `/contacts/${contactId}`, { tags });
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
