# fazer.ai agents — Contexto de Desenvolvimento

> Última atualização: 2026-07-29

## O produto

**fazer.ai agents** — plataforma de agentes de atendimento IA. Fullstack TypeScript: Bun + Elysia + React 19 + Tailwind v4, Prisma/PostgreSQL, LangGraph TS, JWT, i18n, Biome.

Dois transportes de WhatsApp:
- **Chatwoot** — integração original, via Agent Bot webhook
- **Whazing** — integração nova, via External API Bearer token

Duas edições:
- **Free** (open-source) — este repo. Gated: branding custom, multi-tenant UI
- **Full** (privado) — Pro, inclui branding e tenant management

---

## Deploy

| Item | Valor |
|------|-------|
| VPS IP | `178.253.250.120` |
| Repo source | `/opt/fazer-ai/agents-src/` |
| Compose dir | `/opt/fazer-ai/agents/` |
| Compose file | `compose.agents.yml` |
| Env file | `agents.env` |
| Imagem | `agents:local` |

**Deploy correto:**
```bash
cd /opt/fazer-ai/agents-src && git pull
docker build -t agents:local .
cd /opt/fazer-ai/agents && docker compose --env-file agents.env -f compose.agents.yml up -d --no-deps agents
```

**Nunca usar:** `docker-compose.prod.yml` (cria containers errados com imagem `ghcr.io`).

---

## Whazing — O que está implementado

### Client (`src/modules/whazing/client.ts`)

Métodos disponíveis:
- `sendMessage(ticketId, text)` — POST `/` (enviar mensagem)
- `sendPrivateNote(ticketId, text)` — POST `/` com flag
- `sendFile(ticketId, file, ...)` — multipart upload
- `toggleTyping(ticketId, on)` — stub (não suportado)
- `getTicket(ticketId)` — GET `/ticket/:id`
- `assignTicketToUser(ticketId, userId)` — POST `/updateticketinfo`
- `assignTicketToQueue(ticketId, queueId)` — POST `/updatequeue`
- `closeTicket(ticketId)` — POST `/updateticketinfo` status=closed
- `setContactTags(contactId, tags)` — POST `/updatetag`
- `kanbanGetBoards()` — GET `/kanbanpro/boards`
- `kanbanGetColumns(boardId)` — GET `/kanbanpro/boards/:id/columns`
- `kanbanCreateOrMove(params)` — POST `/kanbanpro/card`
- `kanbanGetContactCards(contactId)` — GET `/kanbanpro/contact/:id/cards`
- `kanbanUpdateCard(cardId, fields)` — PUT `/kanbanpro/card/:id`

### Native Tools (`src/modules/whazing/tools.ts`)

Ferramentas disponíveis na runtime Whazing:
- `handoff_to_human` — transfere para fila + usuário
- `close_conversation` — fecha ticket
- `add_private_note` — nota interna
- `kanban_move_card` — move/cria card no Kanban Pro (usa `contactId` do ctx)
- `update_kanban_task` — atualiza card existente no Kanban Pro

**`WhazingToolCtx`:** `{ tenantId, instanceId, client, ticketId, contactId? }`

`CHATWOOT_ONLY_TOOLS` — ferramentas que NÃO existem no Whazing (set_voice_preference, custom_attribute, label management, Chatwoot kanban).

### Runtime (`src/modules/whazing/runtime.ts`)

- Passa `contactId: event.contact?.id` para o ctx das tools
- Chama `loadAgentConfig({ instanceId: BigInt(0), conversationId: ticketId })` — prompt vars de contato/inbox ficam vazias (TODO)

### Webhook receiver

Mounted: `/api/v1/whazing/webhook/:routeToken`
Idempotency: `WhazingWebhookDelivery`
Gate: `shouldWhazingBotHandle`
Routing: `WhazingInbox` → `agentId` (catch-all partial unique index)

---

## Whazing Kanban Pro

### Backend proxy endpoints (`src/api/v1/whazing.controller.ts`)

- `GET /v1/whazing/instances/:id/kanban/boards` → `{ boards: [{id, name, color}] }`
- `GET /v1/whazing/instances/:id/kanban/boards/:boardId/columns` → `{ columns: [{id, name, color}] }` (sorted by position)

### Settings (`src/modules/kanban/settings.ts`)

```ts
interface KanbanWhazingBoard {
  instanceId: string;
  boardId: number;
  boardName: string;
  columns: KanbanWhazingColumn[];
}
```

Salvo em `agent.settings.kanban.whazingBoard`.

### Injeção no runtime (`src/graph/prepare.ts`)

Se `cfg.kanbanConfig.whazingBoard` está presente, injeta nas `toolInstructions` do `kanban_move_card`:
```
Whazing Kanban board: "<boardName>" (boardId: <id>).
Available columns:
  • <name> (columnId: <id>)
  ...
```

### Editor (`ToolGrantsEditor.tsx`)

Board picker na seção Kanban (quando agente tem instância Whazing):
1. Dropdown de instância (auto-seleciona se só 1)
2. Dropdown de boards (lazy-load da API)
3. Lista de colunas com ID badges
4. Textarea para instruções adicionais

---

## Whazing API Pro — Cobertura atual

| Recurso | Endpoint | Status |
|---------|----------|--------|
| Kanban Pro — criar/mover card | `POST /kanbanpro/card` | ✅ tool + client |
| Kanban Pro — atualizar card | `PUT /kanbanpro/card/:id` | ✅ tool + client |
| Kanban Pro — listar boards | `GET /kanbanpro/boards` | ✅ client + proxy |
| Kanban Pro — listar colunas | `GET /kanbanpro/boards/:id/columns` | ✅ client + proxy |
| Tags no contato | `POST /updatetag` | ✅ client (sem tool nativa ainda) |
| Atribuir à fila | `POST /updatequeue` | ✅ client + handoff tool |
| Atribuir a usuário | `POST /updateticketinfo` | ✅ client + handoff tool |
| Fechar ticket | `POST /updateticketinfo status=closed` | ✅ tool `close_conversation` |
| API Plus (listas, botões) | `POST /apiplus` | ❌ não implementado |
| API Oficial (HSM templates) | `POST /apioficial` | ❌ não implementado |
| CRM / pipeline | `POST /updatecrm` | ❌ não implementado |
| Follow-up agendado | `POST /updatefollowup` | ❌ não implementado |
| Listar filas | `GET /queue` | ❌ 403 via External API |

---

## Handoff config Whazing

Campo `whazingQueueId` no `HandoffUiState` — ID da fila para onde rotear após handoff.
Salvo em `agent.settings.handoff.whazingQueueId`.
Injetado nas `toolInstructions` do `handoff_to_human` via `src/graph/prepare.ts`.

---

## Pendências conhecidas

### `{{canal}}` prompt variable para Whazing

A variável `{{canal}}` vem do `loadAgentConfig` que lê o nome do inbox Chatwoot.
No Whazing, `loadAgentConfig` é chamado com `instanceId: BigInt(0)` → prompt vars vazias.
Para implementar: popular `{{canal}}` com `WhazingInstance.name` ou `WhazingInbox.name`.

---

## Erros de deploy históricos (para não repetir)

| Erro | Causa | Fix |
|------|-------|-----|
| Repo não encontrado | Tentou `git pull` em `/opt/fazer-ai/agents/` | Git repo está em `agents-src/`, não `agents/` |
| Compose file errado | Usou `docker-compose.prod.yml` | Usar `compose.agents.yml` com `--env-file agents.env` |
| Postgres unhealthy | `up` sem `--env-file agents.env` | Sempre passar `--env-file` |
| Containers `agents-src_*` | Rodou compose de dentro de `agents-src/` | Compose roda de `/opt/fazer-ai/agents/` |

---

## Arquitetura multi-tenant

- Isolamento por `tenant_id` em tudo
- Prisma `$extends` + Postgres RLS
- Role runtime não-superuser (`secv4_app`) — raw `psql` retorna 0 rows sem `SET app.tenant_id`
- Para diagnosticar: conectar como superuser via `MIGRATION_DATABASE_URL` ou setar GUC

## Encriptação

- `ENCRYPTION_KEY` — encripta tokens/secrets no DB
- Usar `encryptJson()` / `decryptJson()` de `src/api/lib/crypto.ts`
- Nunca logar, nunca expor em API response

## Edition split pattern

Features Pro-only usam stubs que jogam `ProEditionError`. O swap Free↔Full é feito no build:
- `branding.admin.service.ts` — stub (Free) / implementação real (Full)
- `tenants.admin.service.ts` — stub (Free) / implementação real (Full)
- `EDITION` / `IS_FREE` em `src/client/lib/env.ts` — default `"full"` em dev

---

## Commits recentes relevantes

```
7cef9ee feat(whazing/kanban): board + column picker in agent editor
026745b feat(whazing/kanban): add Whazing Kanban Pro native tools
9e01482 feat(tools): filter Chatwoot-only native tools and add Whazing Queue ID handoff config
6a0db81 feat(ui): disable Chatwoot from UI navigation and agent editor
030b5e7 fix(whazing): wire handoff toolInstructions to Whazing native tools
```
