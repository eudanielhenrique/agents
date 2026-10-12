# Documento de Decisão: Análise de Impacto, Riscos e Viabilidade da Remoção do Chatwoot

> **Data:** 10 de outubro de 2026  
> **Status:** Para Decisão do Daniel (Nenhuma linha de código ou tabela foi removida)  
> **Alvo:** Decisão estratégica sobre migração para Whazing 100% standalone e estabilização de agentes.

---

## 1. Sumário Executivo e Veredito Crítico

> [!CAUTION]
> **Remover o Chatwoot NÃO resolve as falhas e silêncios dos agentes.**  
> A investigação aprofundada de causa-raiz demonstrou que a remoção do Chatwoot é puramente cosmética/estrutural. Os problemas reais de "agente travado / parando de responder" têm origem em **pontos cegos duplicados identicamente nos dois módulos (Whazing e Chatwoot)** e em **gargalos no core compartilhado**. Inclusive, todos os incidentes de produção registrados recentemente no código (agosto a outubro de 2026) ocorreram no **Whazing** ou no **pipeline comum de entrega**, e nenhum teve o Chatwoot como causa.

A remoção do Chatwoot é **viável e recomendável a médio prazo** para reduzir a superfície do sistema (eliminar ~19.600 linhas de código legado, dependência de webhooks externos não controlados e manutenção duplicada). Contudo, **se o objetivo imediato for estancar as dores de cabeça com falhas de agentes em produção, a prioridade absoluta número 1 deve ser a aplicação das 5 correções de confiabilidade no core e no Whazing.**

---

## 2. Mapa de Acoplamento do Chatwoot

A investigação arquitetural revelou um fato crucial sobre o repositório:
**Não existe um runtime unificado de agentes.** O Chatwoot e o Whazing operam com runtimes totalmente paralelos:
- **Fluxo Chatwoot:** `src/graph/runtime.ts` (991 linhas) + `src/graph/prepare.ts` + `src/graph/tools/native.ts` (é o runtime do Chatwoot disfarçado de core).
- **Fluxo Whazing:** `src/modules/whazing/runtime.ts` (1.249 linhas, autossuficiente) + `src/modules/whazing/tools.ts`.

A única interface verdadeiramente compartilhada é `InboxReplyClient` em `src/lib/transport/inbox-client.ts` (53 linhas), implementada por ambos.

### 2.1 Inventário de Código Chatwoot Removível (~19.600 linhas no total)

| Categoria | Arquivos | Linhas | Descrição |
|---|---|---|---|
| `src/modules/chatwoot/` | 19 arquivos | ~6.760 | SDK Chatwoot (`client.ts` 2.458 linhas), normalização de eventos, espelhamento de atributos, kanban via API Chatwoot, provisioning, etc. |
| API Controllers | 2 arquivos | 653 | `chatwoot.controller.ts` e `chatwoot-admin.controller.ts` (rotas de webhook e administração). |
| Frontend exclusivo | ~5 arquivos | ~1.720 | `ChannelsPage.tsx` (página antiga Chatwoot), `src/client/pages/chatwoot/*`, `chatwootLinks.ts`. |
| `src/graph/*` (Runtime legado) | 11 arquivos | ~8.950 | Runtime e preparadores acoplados ao Chatwoot (Whazing tem o seu próprio). |
| Frontend compartilhado / Locales | ~4 arquivos | ~500 | Branches em `ConversationDetailPage.tsx`, `ChannelsTab.tsx` e chaves i18n (`pt-BR.json`, `en-US.json`). |
| Testes exclusivos / Seeds | ~4 arquivos | ~400 | `tests/utils/chatwoot.ts` e testes unitários do módulo Chatwoot. |
| Scripts, docs e skills | ~8 arquivos | ~1.000 | `docs/chatwoot.md`, skills de operação e scripts de provisionamento legados. |

---

## 3. O Whazing Consegue Rodar 100% Standalone Hoje?

> [!WARNING]
> **Resposta: NÃO roda hoje se deletarmos a pasta do Chatwoot diretamente.**  
> O Whazing é 98% autossuficiente, mas possui **bloqueantes diretos de runtime e compilação** que dependem de arquivos dentro de `src/modules/chatwoot/`.

### 3.1 Bloqueantes que Quebram o Whazing (Exigem Extração Prévia)

1. **`outOfHoursGate` (`src/modules/whazing/webhook.ts:8`):**  
   O Whazing importa a função de portão de horário de atendimento direto de `../chatwoot/webhook.ts:563`. Essa função é pura e só depende do módulo neutro `business-hours/hours`, mas está fisicamente dentro do arquivo de webhook do Chatwoot. Se o Chatwoot for deletado sem mover essa função, **o webhook do Whazing quebra em tempo de execução**.
2. **`cleanTranscription` (`src/modules/whazing/render.ts:1` e `media.ts:6`):**  
   Função pura de sanitização de texto transcrito de áudio importada de `chatwoot/render`. Quebra a ingestão de áudio do WhatsApp.
3. **`matchKanbanStep` e `KanbanContext` (`src/graph/tools/native.ts:14`):**  
   Usados pelo montador de ferramentas do graph.
4. **`type ChatwootClient` em arquivos de runtime/nudge (`whazing/nudge.ts:23`, `whazing/runtime.ts:26`, `graph/prepare.ts:28`):**  
   Imports de tipo que quebram o TypeScript (`bun check` / `tsc`).

### 3.2 O que o Whazing já tem de forma 100% Autônoma e Superior
- **Roteamento de intake e campanhas:** `intake.ts` e `intake-settings.ts` (distribui leads por agente/fila de acordo com horários e tags).
- **Kanban Próprio:** `tools.ts` integra-se diretamente à API do **Kanban Pro** (`/kanbanpro/*`), sem depender do Chatwoot.
- **Ferramentas Nativas:** `handoff_to_human`, `close_conversation`, `add_internal_note`, `save_anamnesis_data`.
- **Controle de Mensagens em Rajada e SLA:** `debounce.ts`, `bot-send-tracker.ts` e `human-sla.ts`.

---

## 4. O que Perdemos com a Remoção? (Prejuízos e Riscos)

### 4.1 Perdas Funcionais Reais
1. **Atendimento Multicanal Além do WhatsApp:** O Chatwoot fornecia canais nativos para Telegram, Live-Chat web, Instagram e e-mail. Focar 100% em Whazing significa que a plataforma passa a ser **exclusiva para WhatsApp** (via Whazing).
2. **Histórico de Conversas e Contatos Antigos:** Se existirem tenants em produção com dados vinculados às colunas `chatwootConversationId`, `chatwootContactId` e instâncias do Chatwoot, eles perderão os deep-links de atendimento do painel.
3. **Operação e Ferramentas MCP de Canais:** O servidor MCP expõe ferramentas de escrita de canais Chatwoot (`src/modules/mcp/write-channels.ts`).

### 4.2 Riscos Técnicos e de Banco de Dados
- **Risco de Migração de Banco (Prisma):** O schema contém modelos `ChatwootDeployment`, `ChatwootInstance`, `ChatwootInbox` e chaves estrangeiras. Remover esses campos sem uma nova migration de drop cuidadosa ou limpar migrations históricas corrompe o histórico do Prisma.
- **Risco em Testes de Tenancy:** Testes centrais de isolamento multi-tenant (`tests/lib/tenancy.integration.test.ts`) importam `seedChatwootInstance()`. A suíte inteira de CI quebra se os helpers de mock não forem refatorados para Whazing primeiro.

---

## 5. Investigação de Causa-Raiz: Por Que os Agentes Realmente Falham?

A investigação dos subagents revelou os 5 motivos reais pelos quais clientes ficam sem resposta e agentes "travam". Todos são compartilhados ou estão dentro do próprio Whazing:

### 1. Mensagens presas em `PROCESSING` para sempre (Sem Reaper nos Ledgers)
- **Localização:** `src/modules/whazing/webhook.ts:148-150` e `src/modules/whazing/webhook.ts:317-324`.
- **O Bug:** O webhook usa CAS (`PENDING` → `PROCESSING` → turno → `PROCESSED`). Se ocorrer qualquer exceção, timeout de rede ou reinício de pod durante o turno do agente, o bloco `catch` apenas faz log e registra explicitamente no comentário: *`"Leave in PROCESSING — reaper will reset to PENDING for retry"`*.
- **A Realidade:** **Esse reaper NÃO existe.** O código promete um reaper que nunca foi implementado. Resultado: a mensagem fica em `PROCESSING` eternamente no banco e o cliente nunca recebe resposta.

### 2. Ausência de Dead-Letter Queue (`FAILED` / `DEAD` nunca são escritos)
- **Localização:** `prisma/schema.prisma` vs `src/modules/whazing/webhook.ts`.
- **O Bug:** O enum prevê `FAILED` e `DEAD`, mas o código do Whazing só executa `create`, `findFirst`, `CAS updateMany` e `mark-PROCESSED`. Não há contagem de tentativas nem descarte seguro. Falhas recorrentes envenenam o fluxo sem deixar rastros operacionais.

### 3. Chamadas de Modelo LLM sem Timeout (`models.ts`)
- **Localização:** `src/graph/models.ts:145-211`.
- **O Bug:** Todas as instâncias de `ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI` e `ChatDeepSeek` são inicializadas **sem parâmetro `timeout`** e sem `maxRetries` explícito. Se o provedor de IA engasgar ou demorar para fechar a conexão, a requisição do agente fica pendurada indefinidamente, segurando o turno e a fila.

### 4. Semáforo de Modelo Global em vez de por Tenant
- **Localização:** `src/graph/model-limit.ts:13-17`.
- **O Bug:** O semáforo que limita chamadas simultâneas de LLM é instanciado em `globalThis` de forma **global para a aplicação inteira**. Se um único tenant sofrer um pico de tráfego ou entrar em loop, ele consome todas as vagas de concorrência e **derruba ou atrasa os agentes de todos os outros clientes**.

### 5. Alertas Ocultos por `minLevel=error` e Silêncios Falsos
- **Localização:** `src/modules/flowlog/alerts.ts:41-42` e `src/modules/split/service.ts:126-141`.
- **O Bug:** Os alertas de canal filtram eventos abaixo de `error` por padrão (`minLevel = error`), descartando dezenas de pontos vitais emitidos como `warn` no webhook. Além disso, se o turno do agente retorna texto vazio ou sofre falha no split, ele é tratado como encerramento silencioso (incidente documentado em outubro/2026 onde leads ficaram horas sem resposta porque uma falha foi interpretada erroneamente como "precisa de humano").

---

## 6. Plano de Ação Recomendado (Sequência Segura)

Recomendamos dividir o trabalho em duas etapas claras:

```mermaid
flowchart TD
    subgraph Fase 1: Estabilização Imediata [Prioridade Máxima: Estancar as Falhas]
        F1["1. Implementar Reaper para PROCESSING stale no Whazing"]
        F2["2. Adicionar timeout explícito no createChatModel (models.ts)"]
        F3["3. Converter Semáforo de Modelo para escopo por Tenant"]
        F4["4. Registrar status FAILED com DLQ após max attempts"]
        F5["5. Elevar logs de falha no webhook para emitFlowEvent de nível ERROR"]
    end

    subgraph Fase 2: Desacoplamento e Remoção do Chatwoot [Após Aprovação do Daniel]
        D1["1. Extrair outOfHoursGate e cleanTranscription para src/lib/ ou módulos neutros"]
        D2["2. Trocar tipagem de ChatwootClient no Whazing e Graph por InboxReplyClient"]
        D3["3. Remover páginas legadas do frontend (ChannelsPage) e chavear para ChannelsHubPage"]
        D4["4. Deletar src/modules/chatwoot/, controllers e endpoints de API Chatwoot"]
        D5["5. Criar nova migration Prisma para dropar tabelas e colunas Chatwoot com segurança"]
        D6["6. Atualizar testes de tenancy substituindo seedChatwootInstance"]
    end

    Fase 1 --> Fase 2
```

### Decisão Solicitada ao Daniel:
1. **Aprova a execução imediata da Fase 1 (as 5 correções de causa-raiz no Whazing e Core)** para resolver as falhas dos agentes?
2. **Aprova a remoção planejada do Chatwoot na Fase 2**, aceitando a transição da plataforma para 100% WhatsApp/Whazing?
