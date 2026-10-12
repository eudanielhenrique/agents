# Architecture

## O que é

**fazer.ai agents** — plataforma self-hosted de agentes de IA para atendimento (WhatsApp e outros canais): transcreve áudio, lê imagem, responde por texto ou voz, consulta base de conhecimento (RAG), agenda, cobra, move funil de kanban e sabe quando passar pra um humano. Multi-tenant, distribuição Free (open-source, Apache 2.0) vs Full/Pro (recursos pagos). Construída sobre o template **bunfire**.

## Stack

| Peça | Escolha | Por quê |
|---|---|---|
| Runtime/servidor | Bun + Elysia | performance + DX do Bun; Elysia como framework HTTP type-safe |
| Frontend | React 19 + Tailwind CSS v4 | — |
| Banco | PostgreSQL + pgvector, Prisma ORM | pgvector pro RAG (embeddings) sem precisar de um segundo banco |
| Orquestração de agente | LangGraph TS | grafo mínimo agent⇄tools com checkpointer Postgres nativo — ver seção Runtime do agente abaixo |
| Auth | JWT | — |
| i18n | pt-BR + en, `t()`/`translate()` com chaves extraídas | — |
| Lint/format | Biome | — |
| Client de API (frontend) | Eden Treaty | tipos derivados direto do backend Elysia, sem tipo duplicado à mão |

## Estrutura de pastas

```
src/modules/     núcleo de domínio — um subsistema por pasta (agents, chatwoot, whazing, debounce,
                 stt, tts, rag, integrations, scheduler, vault, flowlog, followups, handoff,
                 kanban, playground, service-window, split, webhooks, mcp, models, configurator,
                 automations, ...).
                 "Um core, múltiplos transportes" mora aqui — REST v1 / MCP / UI projetam sobre isso.
src/graph/       runtime do agente (LangGraph) + tools/ (ferramentas nativas)
src/api/         backend Elysia — features/ (auth, admin, health, i18n), v1/ (REST + MCP mount),
                 lib/, middlewares/, locales/
src/lib/         libs compartilhadas, incl. tenancy/ (Prisma $extends + RLS Postgres)
src/client/      frontend React (pages/, components/, contexts/, hooks/, lib/, locales/)
prisma/          schema + migrations
docs/            um .md por subsistema — leia antes de mexer no subsistema correspondente
scripts/         db-bootstrap, set-admin, seed, i18n-extract, checks de MCP, setup do template
tests/           espelha src/ (api/, client/, graph/, lib/, modules/)
workers/cdn/     Cloudflare Worker pra assets do frontend via CDN
```

## Como rodar

```bash
bun dev              # dev server com hot reload, porta 3000
bun db:bootstrap      # provisiona a role de runtime não-superusuário (depois de qualquer reset)
bun check             # lint + typecheck + i18n + testes — rodar sempre antes de considerar pronto
bun test              # só os testes
```

Detalhes de setup (porta do Postgres, `bun db:reset` nunca `prisma migrate reset` puro) estão no `CLAUDE.md` da raiz.

## Runtime do agente (LangGraph e Whazing)

Grafo mínimo: nó `agent` (chama o modelo com o histórico) ⇄ nó `tools` (executa as tool calls), loop até o modelo responder sem pedir mais nenhuma ferramenta. Limite de 10 tool calls por turno (soft nudge nos últimos 2, hard stop no limite). O **checkpointer** (`PostgresSaver`, schema `langgraph` dedicado) persiste o histórico de mensagens por `thread_id` — é a memória do agente dentro de uma conversa, e entre conversas do mesmo contato:
- **Chatwoot:** `contactInboxThreadId` via `src/graph/runtime.ts`.
- **Whazing:** por `lid`/telefone do contato via `src/modules/whazing/runtime.ts` e `thread-keys.ts` (ver `docs/whazing.md`).

O system prompt NÃO fica no histórico — é injetado de novo a cada turno, direto da config atual do agente, então editar o prompt vale imediatamente.

Um segundo primitivo, `PostgresStore` (mesmo schema `langgraph`, camada separada do checkpointer), guarda memória de fato entre threads — usado pela ferramenta nativa `remember_fact`, namespaced por contato por transporte (`c_` para Chatwoot, `w_` para Whazing).

## Runtimes e Transportes

Existem hoje dois pipelines paralelos de atendimento:
1. **Chatwoot** (`src/modules/chatwoot/` + `src/graph/runtime.ts`): transporte multicanal original (Agent Bot + webhook). Em análise para descontinuação/remoção.
2. **Whazing** (`src/modules/whazing/`): transporte primário de WhatsApp, autossuficiente com seu próprio `runtime.ts` (1.249 linhas), ferramentas nativas (`buildWhazingNativeTools`), Kanban Pro API, roteamento de intake e controle de rajadas (debounce).
3. **MCP**: servidor próprio com suporte a OAuth 2.1 e toolpacks customizáveis.

Camada de abstração compartilhada: `InboxReplyClient` (`src/lib/transport/inbox-client.ts`), implementado tanto pelo `WhazingClient` quanto pelo `ChatwootClient`.

## Serviços e integrações externas

- **PostgreSQL + pgvector** — banco principal, RLS multi-tenant (role não-superusuário em runtime, ver `docs/tenancy.md`), schema `langgraph` separado pro LangGraph.
- **Whazing** — transporte principal de WhatsApp, webhook de token opaco (`docs/whazing.md`).
- **Chatwoot** — transporte de atendimento legado em processo de transição (`docs/chatwoot.md`).
- **Uber Direct + OSRM** — hub de cálculo de frete e entregas sob demanda com cotações e despachos automáticos.
- **Langfuse** (self-hosted) — observabilidade/tracing por tenant, opt-in, requer o serviço `langfuse-worker` rodando (sem ele, ingestão silenciosamente não persiste nada — ver `docs/graph.md` e a skill de operação).
- **Modelos de LLM** — OpenAI, Anthropic, Google, DeepSeek, ou qualquer endpoint OpenAI-compatível (inclusive local: Ollama, LM Studio, vLLM).
- **Cloudflare R2/CDN** — assets do frontend servidos por CDN (opcional, ver `docs/cdn-r2-setup.md`).

## Decisões arquiteturais não óbvias

- **RLS + `Prisma $extends`** pra isolamento multi-tenant, não filtro manual em toda query — ver `docs/tenancy.md`.
- **`serve.routes` carve-out no Elysia raiz** — sem isso, o handler estático do Bun intercepta `/api/*` antes do Elysia rotear (bug upstream do Bun/Elysia, documentado em detalhe no `CLAUDE.md`).
- **Deploy roda o TypeScript interpretado** (`bun src/index.ts`), não um binário `bun build --compile` — esse binário segfaulta no boot (`docs/bun-compile-segfault.md`).
- **Duas roles de banco**: superusuário só pra migração/bootstrap, role não-superusuário em runtime — falha rápido no boot se invertido (`docs/deploy.md`).
- **`agents-pro-src` (o build de produção real) não é git-tratado pelo repo público** — é uma árvore separada no VPS, agora versionada num repo privado próprio, com divergência real e crescente em relação a este repo público. Nunca assumir que o que está aqui é o que está rodando em produção sem conferir primeiro.

## Cérebro externo (Obsidian)

Além da documentação técnica neste repo (`docs/`, `CLAUDE.md`), Daniel mantém uma base de conhecimento pessoal no Obsidian:

- Vault: `/Users/danielh/Library/Mobile Documents/iCloud~md~obsidian/Documents/Cerebro`
- Notas específicas deste projeto: `BoraAutomatizar/06 - fazer.ai Agents (Plataforma).md`, `BoraAutomatizar/07 - fazer.ai Agents — Changelog Dev (2026-08-21).md`, `AgenteVinicius/02 - Migração fazer.ai Agents (VAX).md`
- Índice geral do vault: `00 - Índice.md` na raiz
