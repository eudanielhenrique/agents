# Roadmap

Feito deriva do `CHANGELOG.md` e do que roda de fato hoje. Planejado deriva das issues abertas no repositório, do trabalho em andamento nas branches e das prioridades estratégicas de negócio.

## Feito

- [x] Runtime de agente sobre LangGraph (grafo agent⇄tools, checkpointer Postgres, limite de tool calls)
- [x] Transporte Chatwoot (Agent Bot + webhook) com atribuição de dono, atributos customizados, kanban, follow-ups
- [x] Transporte Whazing completo — modelos, webhook resiliente, runtime próprio autossuficiente, ferramentas nativas (handoff/nota/encerrar), Kanban Pro API, mídia/STT, debounce, anamnese estruturada, roteamento de intake + campanha, reconciliação diária, analytics
- [x] Terceiro transporte: servidor MCP com OAuth 2.1
- [x] RAG (base de conhecimento com pgvector) + aprovação de sugestão de documento no console
- [x] Multi-tenant com RLS + `Prisma $extends`, role de runtime não-superusuário
- [x] Voz: STT (transcrição de áudio recebido, múltiplos provedores) e TTS (resposta em áudio, reescrita da fala pro ouvido, respeitando o canal de destino)
- [x] Guardrails de moderação e checagem de saída
- [x] Hub de Entregas e Fretes Híbrido (Uber Direct + OSRM gratuito) com automação e toolpacks
- [x] Integrações: Google Calendar (disponibilidade cruzando agendas de bloqueio, criação com sala do Meet), Asaas (cobrança PIX), Nuvemshop (pedido/produto + OAuth self-service)
- [x] Ferramentas HTTP autoráveis pelo operador (JSON Schema, projeção de campos, status declarados)
- [x] Observabilidade: Langfuse por tenant, log de execução por estágio (`ExecutionLog`) com alertas de canal
- [x] Compartilhamento de playground sem login
- [x] Memória entre conversas (`remember_fact`, LangGraph store) — namespaced por contato
- [x] Branding configurável, i18n pt-BR/en, suite de testes de regressão de prompt
- [x] Trilha de auditoria expandida cobrindo edições de agentes, conexões, ferramentas e canais via console

## Em andamento

- [ ] **Estabilização de Agentes e Confiabilidade (Prioridade Zero)**:
  - [ ] Implementar Reaper de entregas presas em `PROCESSING` para o ledger do Whazing (`src/modules/whazing/webhook.ts:150`)
  - [ ] Dead-letter queue com contagem de tentativas e gravação de status `FAILED`/`DEAD`
  - [ ] Timeout e deadline explícitos em `createChatModel` (`src/graph/models.ts:145`) para evitar turnos pendurados
  - [ ] Escopo de concorrência de modelo (semáforo) por tenant em vez de semáforo global
  - [ ] Elevação de eventos de falha encobertos por `minLevel=error` e prevenção de silêncio falso em turnos vazios
- [ ] **Configurador de Agentes (WIP)**: interface e rotas para authoring assistido de agentes (`src/modules/configurator/`)
- [ ] **Hub de Automações (WIP)**: repositório e serviços de regras de automação (`src/modules/automations/`)
- [ ] **Canais Hub (Frontend)**: transição completa do frontend para `ChannelsHubPage.tsx` e `WhazingChannelsTab.tsx`

## Planejado (Backlog Estratégico)

**Transição Whazing 100% Standalone (Pendente de Aprovação do Daniel)**:
- [ ] Extrair funções neutras (`outOfHoursGate`, `cleanTranscription`) de dentro de `src/modules/chatwoot/` para módulos compartilhados
- [ ] Desacoplar referências de tipo `ChatwootClient` em `src/modules/whazing/nudge.ts` e `runtime.ts`
- [ ] Remoção de `src/modules/chatwoot/`, controllers legados e páginas antigas (`ChannelsPage.tsx`)
- [ ] Nova migração de banco para descontinuação de tabelas/colunas Chatwoot preservando histórico

**Governança de Modelo e Custos**:
- [ ] #146 Limite orçamentário e cap de gastos por tenant checado pré-chamada
- [ ] #57 Roteamento inteligente de modelo — turnos simples em modelos rápidos, raciocínio em modelos pesados
- [ ] #140 Classificador dedicado para guardrails em vez do modelo principal do agente

**UX e Agendamento**:
- [ ] #367 Board de CRM contextualizado com motivação de avanço de etapa
- [ ] #386 Declaração explícita de reserva de horário via MCP
- [ ] #363 Validação aprimorada de documentos e regras de negócio
