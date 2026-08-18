# Whazing integration

fazer.ai agents connects to a Whazing instance through a **Bearer API key**, receives channel webhooks on a **dedicated receiver** (opaque route-token auth, no HMAC — Whazing does not sign payloads), and obeys the same attribution gate pattern: the bot acts only while no human has taken over the ticket. The agent runtime lives in [`graph.md`](graph.md); this doc covers the transport, auth, provisioning, the webhook receiver, and the response gate.

## Architecture overview

```
Whazing (WhatsApp gateway)
  ├── channel webhook → POST /api/v1/whazing/webhook/:routeToken
  │                     ack <5s, process async
  └── API (Bearer key)
        ├── POST /api/messages/sendText    ← sendMessage
        ├── POST /messages/sendAudio       ← sendAudioMessage (multipart)
        ├── GET  /tickets/:id              ← getTicket (gate re-check)
        ├── PUT  /tickets/:id              ← assignTicketToQueue / closeTicket
        └── PUT  /contacts/:id             ← setContactTags
```

## Client (`src/modules/whazing/client.ts`)

`createWhazingClient(config)` validates `baseUrl` (anti-SSRF, HTTP allowed for private deployments) and returns a `WhazingClient`. Auth is `Authorization: Bearer <apiKey>`. The client implements `InboxReplyClient` for the shared runtime (`deliverReply`, split delivery).

Key methods:
- `sendMessage(ticketId, text)` — POST `/api/messages/sendText`
- `sendPrivateNote(ticketId, text)` — **no-op.** Whazing has no internal-note API; an earlier version aliased this to `sendMessage`, which sent LLM-internal handoff summaries (occasionally containing patient health details) straight to the customer's WhatsApp thread — a real production incident (2026-08-04, tickets 10345/10348/10354). Until Whazing ships a real internal-note endpoint, the note text is dropped. The `handoff_to_human` tool's queue assignment is the actual signal to staff — they read the transcript themselves for context.
- `sendAudioMessage(ticketId, audio, fileName, mime, opts?)` — multipart POST `/api/messages/sendAudio`
- `toggleTyping(_ticketId, _on)` — no-op (Whazing has no typing indicator API)
- `getTicket(ticketId)` — GET `/api/tickets/:id`
- `assignTicketToUser(ticketId, userId)` / `assignTicketToQueue(ticketId, queueId)` — PUT `/api/tickets/:id`
- `closeTicket(ticketId)` — PUT `/api/tickets/:id` with `{ status: "closed" }`
- `setContactTags(contactId, tags)` — PUT `/api/contacts/:id`

`WhazingApiError` carries `status` + `endpoint` and **never** the response body (PII).

**NOTE**: the endpoint shape for `sendAudioMessage` is tentative — verify against a live Whazing instance before production.

## Instance model and provisioning (`src/modules/whazing/management.ts`)

`WhazingInstance` represents one Whazing API connection per tenant (analogous to `ChatwootInstance`). Credentials are encrypted at rest:

- `apiKey` — encryptJson blob (write-only; never returned in API responses)
- `routeToken` — encryptJson of the plaintext token; kept so `toInstanceDto` can re-derive the webhook URL at any time without storing cleartext
- `routeTokenHash` — SHA-256 of the plaintext token; unique; used for constant-time webhook auth

On create, `generateRouteToken()` produces a 32-byte random token. The plaintext goes into the `webhookUrl` shown to the operator; only its SHA-256 hash is stored in `routeTokenHash`. The encrypted plaintext in `routeToken` exists only so the operator can see the webhook URL later (re-decrypt → re-derive URL).

`WhazingInbox` maps a Whazing queue (by `whazingQueueId`) to a fazer.ai `Agent`. `null` `whazingQueueId` = catch-all (handles any ticket whose queue is not explicitly mapped). Enforced by a partial unique index in the migration:

```sql
CREATE UNIQUE INDEX "whazing_inboxes_catchall_unique"
  ON "whazing_inboxes" ("tenant_id", "instance_id")
  WHERE "whazing_queue_id" IS NULL;
```

## Webhook receiver (`src/modules/whazing/webhook.ts`)

Mounted at `/api/v1/whazing/webhook/:routeToken` (`src/api/v1/whazing-webhook.controller.ts`), JWT-less. The webhook URL shown to the operator is derived from `WHAZING_WEBHOOK_MOUNT` + the plaintext route token at `whazingWebhookUrl(publicUrl, token)`.

Flow:

1. **Resolve**: SHA-256 the route token → `findUnique({ routeTokenHash })` (`asSuperAdmin`, cross-tenant). Returns 401 for unknown tokens and disconnected instances — same response for both (no oracle).
2. **Parse**: JSON-decode the raw body. Non-JSON → 400; non-event payload (normalized to null) → 200 `ignored`.
3. **Normalize**: `normalizeWhazingEvent(raw)` produces a `NormalizedWhazingEvent` or null. Tolerant of multiple field paths per the Whazing API shape.
4. **Idempotency ledger**: `WhazingWebhookDelivery` keyed by `(instanceId, deliveryId)`. Delivery ID = message ID if present, SHA-256 of body otherwise. Stores **no payload** (PII); the normalized event travels in-memory.
5. **Ack < 5s**, then `processWhazingDelivery` fires detached.

`processWhazingDelivery` CAS `PENDING→PROCESSING`, evaluates the gate, runs `runWhazingAgentTurn`, CAS `→PROCESSED`. A failure leaves the row in `PROCESSING` for a future reaper (not yet implemented).

## Event normalization (`src/modules/whazing/normalize.ts`)

`normalizeWhazingEvent(raw)` defensively extracts fields from the Whazing webhook payload into `NormalizedWhazingEvent`:
- `event` — event type string (gated to `WHAZING_HANDLED_EVENTS`)
- `ticketId` — ticket identifier
- `queueId` — queue identifier (string cast in `runWhazingAgentTurn`)
- `message` — `{ id, body, fromMe, isAutomation }`
- `contact` — `{ id, whatsappId }`

`isNewIncomingMessage(event)` — true when event is `"message_received"` AND `ticketId != null` AND body non-empty.

`shouldWhazingBotHandle(event)` — the attribution gate:
```
!fromMe ∧ !isAutomation ∧ assignedUserId == null ∧ status != "closed"
```

`whazingDeliveryId(messageId, rawBody)` — deterministic delivery key (messageId or SHA-256 fallback).

### Human takeover (`WhazingConversation.humanTakeoverAt`)

The gate above is stateless — it trusts whatever `assignedUserId`/`status` came inline on THIS
webhook payload. Queue reassignment away from the bot (e.g. a human answering a ticket while it
still sits in the bot's queue) is driven by an external automation (n8n, per-instance), which
reads the same webhook stream and calls the Whazing API to move the ticket — a round-trip that can
lag behind the customer's very next message. A message that lands before that move completes still
carries the bot's queue, passes the stateless gate, and gets answered on top of the human.

`processWhazingDelivery` (`webhook.ts`) closes that gap locally, without depending on the
automation's timing:

1. `isManualHumanReply(event)` — `fromMe ∧ !isAutomation ∧ sendType ∉ {bot, smartreception}`. True
   only for a human typing directly in Whazing (not our own API send, not Whazing's own
   auto-reply). On a match, `WhazingConversation.humanTakeoverAt` is stamped for that ticket and
   nothing else happens — this message itself is not for the bot to act on.
2. Every subsequent inbound customer message additionally checks that stored flag before invoking
   the agent turn, on top of the stateless gate.

`humanTakeoverAt` is permanent once set — nothing currently clears it (a real handback would need a
fresh `ticketId`, which n8n's own "already answered" routing already keeps out of the bot's queue).
`sendType` is read straight off the webhook payload; `"bot"`/`"smartreception"` are the values
Whazing stamps on API-key sends and its own automation respectively — anything else, including
absent, is treated as a human.

Alongside stamping the flag, `webhook.ts` also best-effort moves the ticket in Whazing itself
(`assignTicketToQueue`, target = `agent.settings.whazingIntake.escalateQueueId` when configured) —
`humanTakeoverAt` alone already stops the bot without it, so a failed/unconfigured move is not fatal.

### Intake routing + campaign leads (`src/modules/whazing/intake.ts`)

Parity with n8n's "recepção inteligente" flow's other two jobs (queue-by-history + campaign
tag/notify) — ported in because n8n was found receiving a small fraction of the real webhook
traffic our own receiver gets (measured live: 52 of our `message_received` deliveries against 2 n8n
executions in the same 25-minute window), so the routing/tagging it drove only fired sporadically.

Runs once, from `processWhazingDelivery`, on the first message we ever see for a ticket (no
`WhazingConversation` row yet) and only while `status === "pending"`:

1. **Routing.** `WhazingClient.listTicketsByPhone` (history, `POST /showallticket`) + `getTicket`
   (current ticket's messages, for a `fromMe: true` human reply already on it) decide whether the
   contact has prior history or this ticket was already answered. If so →
   `assignTicketToQueue(ticketId, whazingIntake.escalateQueueId)`. Otherwise the ticket stays on the
   bot's own queue (`WhazingInbox.whazingQueueId` — no separate field needed, it is the same row
   that already routes this agent's messages).
2. **Campaign signal.** `NormalizedWhazingEvent.campaignSignal` (built by
   `normalize.ts#extractCampaignSignal`, parsed out of the webhook's raw `dataJson` blob — a
   click-to-WhatsApp-ad `ctwa_ad` entry, read from `contextInfo`/`externalAdReply` under whichever
   message-type key is present: `extendedTextMessage`/`imageMessage`/`videoMessage`/
   `documentMessage`/`content`). When present: `setContactTags` with `whazingIntake.campaignTagId`
   (if configured) and `sendMessageToNumber` to `whazingIntake.campaignNotifyPhone` with
   `whazingIntake.campaignNotifyMessage` (`{{ctwaClid}}` interpolated).

Every call is try/caught and logged — a failed routing or tagging attempt never blocks the bot from
answering the message that triggered it. Config lives in `agent.settings.whazingIntake` (off by
default; see `intake-settings.ts`), exposed in the editor's Tools tab and via MCP's
`agent_settings_set`. **Whazing has no queue-list or tag-list endpoint** (confirmed against the
official Postman collection — `/updatequeue`/`/updatetag` only apply an id you already know), so
`escalateQueueId`/`campaignTagId` are typed by hand, same as `handoff.whazingQueueId`.

If more than one agent on an instance has `whazingIntake.enabled`, the first one found wins (logged
as a warning) — the feature assumes one intake-owning agent per instance, matching every production
setup seen so far.

## Thread / memory keys (`src/modules/whazing/thread-keys.ts`)

The LangGraph thread key must survive ticket close/reopen. The preferred key is contact + channel (WhatsApp sender ID):

```
tenant:<tenantId>:whazing:<instanceId>:channel:<whatsappId>:contact:<contactId>
```

Fallbacks (when whatsappId/contactId are unavailable):

```
tenant:<tenantId>:whazing:<instanceId>:number:<normalizedPhone>
tenant:<tenantId>:whazing:<instanceId>:ticket:<ticketId>
```

`resolveWhazingGraphThreadId(tenantId, instanceId, opts)` applies these in order of specificity. The ticket-scoped key is last-resort MVP — replace with contact-channel once the spike confirms `whatsappId` is always present in webhook payloads.

## Agent runtime (`src/modules/whazing/runtime.ts`)

`runWhazingAgentTurn` is the Whazing-specific parallel of `runAgentTurn` in `src/graph/runtime.ts`. Key differences:

1. **Inbox resolution**: `WhazingInbox.findFirst({ where: { tenantId, instanceId, whazingQueueId: String(queueId) } })` → catch-all fallback (null queueId). No match → `"no-agent"`.
2. **Thread key**: `resolveWhazingGraphThreadId` (contact-channel preferred).
3. **loadAgentConfig**: called with `instanceId: BigInt(0)` and `conversationId: ticketId`. The Chatwoot conv query returns null (no such row); contact/inbox prompt vars are empty (known MVP limitation). TODO: add a `WhazingConversation` row for proper context when the spike confirms the data shape.
4. **Media ingestion**: after loading `loaded`, `resolveWhazingSttConfig` reads the agent's STT settings. If enabled and an audio attachment (`mediaType === "audio"|"voice"|"ptt"`) is present, `transcribeWhazingAudio` downloads the `mediaUrl` (SSRF-safe, no-auth) and calls the provider. `renderWhazingMessage(event, transcription)` shapes the final text for the LLM, producing audio markers on failure. The whole path is best-effort — a misconfig or download error falls back to the marker string, never strands the delivery.
5. **buildToolset**: Whazing-native tools injected via `buildWhazingNativeTools` (closure-bound to the `WhazingClient` and `ticketId`). The `ctx.client` cast (`as unknown as ChatwootClient`) is safe — `buildToolset` only uses it for slow-tool acks (sendMessage + toggleTyping, both in `InboxReplyClient`); `buildWhazingNativeTools` ignores its `ctx.client` argument.
6. **Re-check before reply**: `client.getTicket(ticketId)` after the model answers. If `assignedUserId != null` or `status === "closed"`, the bot was taken over → `"taken-over"` (no post).
7. **deliverReply**: shared with Chatwoot via `InboxReplyClient`; split delivery works normally.

## Native tools (`src/modules/whazing/tools.ts`)

`buildWhazingNativeTools(ctx, allowed?)` returns the Whazing-native subset of the global `NATIVE_TOOL_NAMES` catalog. Tool names are the same as Chatwoot so the agent editor's native-tool allowlist works without schema changes:

| Tool name | Whazing implementation |
|---|---|
| `handoff_to_human` | `sendMessage` (customer) + `sendPrivateNote` + `assignTicketToQueue` (optional) |
| `private_note` | `sendPrivateNote` |
| `resolve_conversation` | `closeTicket` |
| `skip_reply` | no-op |
| `calculator` | exact arithmetic |
| `get_current_time` | current datetime in agent timezone |

Chatwoot-specific tools (`set_custom_attribute`, `assign_label`, `set_voice_preference`, `react_to_message`) are **not** exposed for Whazing agents — they rely on Chatwoot API endpoints unavailable in Whazing. The reverse also exists: `send_button_message`/`send_list_message`/`send_carousel_message`/`send_pix_button`/`request_payment`/`save_anamnesis_data` are Whazing-only capabilities, stubbed as a declining "not available on Chatwoot" tool in `src/graph/tools/native.ts` (`unsupportedOnChatwootTool`) so a Chatwoot-attached agent that somehow has one granted gets a clear message instead of the tool silently not existing — and so `buildNativeTools`'s own test (every catalog name must be buildable) still holds.

### `save_anamnesis_data` — structured intake data + the anti-repeat mechanism

Persists patient intake/anamnesis fields on the Whazing **contact** (`extraInfo`, via `/updatecontact`) — not the ticket, so it survives across that contact's tickets. `WhazingClient.getContact`/`updateContactExtraInfo` fetch-then-merge client-side (upsert by field `name`) rather than trusting a partial write, since `/updatecontact`'s documented example sends the whole `extraInfo` array with no sign of a server-side partial merge.

The other half of the fix is in `runtime.ts`: every turn fetches the contact's current `extraInfo` (best-effort) and prepends a `[Dados já coletados... NÃO pergunte de novo: ...]` block to the message text before it reaches the model — the concrete fix for "the agent keeps asking the same anamnesis questions it already got answered." The system prompt still has to instruct the model to actually call the tool as answers come in; this only supplies the grounding once it does.

### Self-echo (bot-send-tracker.ts) — do not confuse our own reply for a human

`isManualHumanReply` (normalize.ts) originally trusted `sendType` alone to tell a human typing directly in Whazing apart from the echo of our own sent reply. That assumption turned out false in production — Whazing doesn't reliably stamp `sendType` as `"bot"`/`"smartreception"` on the echo of a message sent through our API — which self-silenced the bot right after its own first reply on some tickets (confirmed: a solo test conversation, no human involved, got `humanTakeoverAt` set ~14s after the bot's own message).

`bot-send-tracker.ts` tracks OUR OWN sends instead — a signal we fully control. Every customer-facing send (`deliverReply`'s split-delivered reply, and every Whazing-native tool that messages the customer: `handoff_to_human`'s customer message, buttons/list/carousel, PIX button, payment request) calls `markBotSent(instanceId, ticketId)`; the takeover check in `webhook.ts` skips a `fromMe: true` event that arrives within that window (60s) regardless of what `sendType` says. In-memory, single-process — same invariant as `graph/inflight.ts`.

## Operator setup checklist

1. Deploy with `ENCRYPTION_KEY` set (credentials are encrypted at rest).
2. Navigate to **Whazing** in the sidebar → **Add instance**.
3. Enter: **Name** (display), **Base URL** (`https://your-whazing.com`), **API key**.
4. Copy the generated **Webhook URL** and paste it into your Whazing dashboard as the channel webhook.
5. Add queues: for each Whazing queue you want AI to answer, click **Add queue** and enter the **Queue ID** (from Whazing) and select an **Agent**. Leave Queue ID blank to create a catch-all that handles any ticket not matched by a specific queue.
6. Ensure the assigned agent persona has a model key configured (Vault → add an API key, then reference it in the agent's Model settings).
7. Test by sending a WhatsApp message. Check **Logs** for a turn with `source: "inbox"`.

## Security notes

- **No HMAC**: Whazing does not sign webhook payloads. The route token (32 random bytes, SHA-256 in DB) is the sole auth. Keep the webhook URL secret.
- **Encrypted credentials**: `apiKey` and `routeToken` are encrypted with `ENCRYPTION_KEY`. Rotating the key invalidates all stored values — plan a migration.
- **SSRF**: `assertSafeOutboundUrl(baseUrl, { allowHttp: true })` is called at client construction. Private IPs and cloud metadata endpoints are blocked; HTTP is allowed for private Whazing deployments.
- **PII**: The webhook ledger stores no payload (only event type + status). No customer message content is persisted by this module.

## MVP limitations and known TODOs

- `sendAudioMessage` endpoint shape is tentative — verify against a live instance.
- `sendPrivateNote` is a permanent no-op (see client method docs above) — Whazing has no internal-note API, and there is no operator-visible fallback for handoff reasons or `private_note` content today.
- `loadAgentConfig` with `instanceId: BigInt(0)` means contact/inbox prompt variables are empty. A dedicated `WhazingConversation` row would fix this.
- Media ingestion: STT for voice notes is wired (`renderWhazingMessage` + `transcribeWhazingAudio` in `src/modules/whazing/render.ts` + `media.ts`). Vision (image description) is not yet implemented.
- A PROCESSING→PENDING reaper (stranded delivery recovery) is not yet implemented.
- The debounce, STT, TTS, service-window, and channel-redirect subsystems are Chatwoot-only — they can be extended to Whazing in follow-up issues.
- `set_voice_preference` is not available (would need a `Contact` row for the Whazing contact, which is not currently mirrored).
