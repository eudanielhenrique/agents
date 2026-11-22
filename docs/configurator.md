# WhatsApp Configurador

Lets a tenant admin configure their own agent (system prompt + behavior settings) by chatting with
a dedicated persona on the fazer.ai-operated WhatsApp number, instead of only through the console or
a real MCP client. The design goal was reuse: almost none of this is new business logic — it is the
existing MCP write spine (`src/modules/mcp/write.ts`) driven by a synthesized principal instead of a
real OAuth token.

## Identity: WhatsApp contact → tenant

There is no e-mail/OTP sender in this codebase, so linking reuses the pattern the repo already has
twice (`/setup`'s token, MCP's authorization code): a one-time, hashed, short-TTL code generated
from an authenticated console session, pasted as the first WhatsApp message. Proof of possession is
controlling the console session, not an out-of-band secret channel.

1. A TENANT_ADMIN generates a code from **Settings → Configurador** (`POST /v1/configurator/link-code`,
   `issueLinkCode` in `src/modules/configurator/service.ts`). 10-minute TTL, returned once in clear.
2. They paste it as the first message to the Configurador WhatsApp number. The `link_whatsapp_account`
   tool (always available, even before any binding exists) calls `redeemLinkCode`: single-use CAS
   consume (mirrors `exchangeAuthorizationCode` in `mcp/oauth/grant.ts`), then upserts a
   `ConfiguratorBinding` keyed on `(channel, instanceId, externalContactId)`.

`ConfiguratorLinkCode` / `ConfiguratorBinding` are **GLOBAL tables (NO RLS)** — same category as
`mcp_oauth_*`: the webhook resolves a contact before any tenant context exists, so RLS would
fail-closed. They are accessed via the base Prisma client with manual tenant filtering, and are
deliberately absent from `TENANT_SCOPED_MODELS` (`src/lib/tenancy/multi-tenant.ts`).

Console: `src/api/v1/configurator.controller.ts` (`POST link-code` / `GET binding` / `DELETE
binding`, all TENANT_ADMIN), UI at `src/client/pages/settings/SettingsConfiguratorPage.tsx`
(`/settings/configurador`).

## Tools (`src/graph/tools/configurator.ts`)

Transport-agnostic — no `ChatwootClient`/`WhazingClient` involved, only DB + the MCP write
functions — so `buildToolset` (`src/graph/prepare.ts`) wires them in on the **common** path rather
than per-transport, the same way for a Configurador persona on either Chatwoot or Whazing.

Gated on `agent.settings.configurator === true` (`readConfiguratorEnabled`) AND `ToolsetCtx.
configuratorContact` being set. The two runtimes populate `configuratorContact` from their own
contact-id shape: `src/graph/runtime.ts` from `AgentConfig.chatwootContactId` (same source as the
existing `{{contact_id}}` prompt var), `src/modules/whazing/runtime.ts` from the ticket event's
`contactId` directly (Whazing's `loadAgentConfig` never populates contact fields — a known
limitation documented in `docs/whazing.md`).

When no binding resolves yet, only `link_whatsapp_account` is exposed. Once bound, the tool set adds:

- `agent_list` → `agentList`
- `agent_prompt_set` → `promptSet`
- `agent_settings_get` / `agent_settings_set` → `agentSettingsGet` / `agentSettingsSet`, restricted
  by the tool's own zod schema to the `debounce`/`stt`/`tts`/`split`/`serviceWindow`/`grounding`
  blocks (the underlying service supports more; this tool deliberately doesn't expose them)

All four call the real `src/modules/mcp/write.ts` functions directly, via a `VerifiedToken`
synthesized by `principalFromBinding` (`{userId, tenantId, role: "TENANT_ADMIN", scopes: ["mcp:read",
"mcp:write"], clientId: "whatsapp-configurator", jti: randomUUID()}` — those functions only read
that shape, they don't require a real signed JWT). Every existing MCP guarantee comes along for
free: tenant-fenced by RLS (a binding can only ever touch its own tenant's agents), dry-run by
default, and audited on apply (`AuditLog`, `actorType: "mcp"` — these writes are indistinguishable
from a real MCP client's in the audit trail; the WhatsApp contact/channel is not separately
recorded there).

**Confirmation has no new mechanism.** The wrapped functions already default `dry_run: true` and
only mutate on an explicit `dry_run: false`. The Configurador persona's system prompt is what
enforces "show the preview, wait for the customer's explicit go-ahead before ever passing
`dry_run:false`" — the same trust model the runtime already places in other tools (e.g. the deferred
`resolve_conversation` intent).

## Deliberately out of scope (v1)

No credentials/vault, channels/webhooks, or tool grants (`agentToolsSet`) from inside a WhatsApp
conversation — same secret-by-reference boundary MCP itself enforces. Only prompt + the six behavior
blocks above are reachable. Widening this is a v2 decision, not an oversight.

## Setup

A normal `Agent` on the fazer.ai-operated instance (Chatwoot or Whazing — whichever fazer.ai's own
support number runs on) with `agent.settings.configurator = true`, bound to an inbox the usual way
(`bindInbox`/Whazing queue mapping). Its system prompt should explain the linking flow and the
confirm-before-apply rule explicitly.
