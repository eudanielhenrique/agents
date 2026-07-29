# Plano de Integração Whazing como Transport First-Class

Repositório: `eudanielhenrique/agents`

## Objetivo

Adicionar o Whazing como um transport first-class ao lado do Chatwoot, mantendo o runtime de agentes desacoplado da plataforma de atendimento.

A arquitetura desejada é:

```txt
Core fazer.ai agents
  ├─ LangGraph runtime
  ├─ memória
  ├─ RAG
  ├─ ferramentas
  ├─ observability
  └─ transport adapters
       ├─ Chatwoot
       └─ Whazing
```

## Leitura estratégica

O Whazing pode ocupar o mesmo papel de produto que o Chatwoot:

- receber mensagens de WhatsApp/canais;
- organizar tickets;
- manter contatos;
- operar filas;
- entregar respostas;
- permitir atendimento humano;
- expor API e webhooks.

Mas o modelo técnico é diferente:

```txt
Chatwoot = inbox/conversa + Agent Bot webhook + bot token
Whazing  = ticket/contato/fila + webhook de canal + API de envio
```

No Chatwoot, existe o conceito nativo de Agent Bot. No Whazing, a integração provavelmente precisa ser construída via Webhook de Canal + API.

## Fluxo esperado com Whazing

```txt
Cliente manda WhatsApp
   ↓
Whazing recebe mensagem
   ↓
Whazing dispara Webhook de Canal
   ↓
Nosso backend recebe evento
   ↓
Valida, normaliza ticket/contato/mensagem
   ↓
Roda LangGraph/agente
   ↓
Envia resposta pela API Whazing
   ↓
Whazing entrega no WhatsApp
```

## Mapeamento conceitual Chatwoot → Whazing

| Conceito no Chatwoot/fazer.ai | Equivalente provável no Whazing |
|---|---|
| Conversation | Ticket |
| Contact | Contact |
| Inbox | WhatsApp/channel/conexão |
| Agent Bot | Chatbot/configuração externa ou adapter próprio |
| Assignee human | `userId` |
| Team/queue | `queueId` |
| Status `pending/open/resolved` | `status` do ticket |
| Labels | Tags |
| Custom attributes | `extraInfo`, CRM, Kanban, follow-up |
| Message body | `messageBody` |
| Message id | `messageId` |
| From customer/bot | `fromMe`, `sendType`, `user` |
| Attachment | `mediaType`, `mediaUrl` |
| Handoff | `updateticketinfo` / `updatequeue` |
| Thread memory | contact + channel, com fallback para ticket |

## Interface de transport desejada

O core do agente não deve conhecer detalhes de Chatwoot ou Whazing. A integração deve passar por uma interface neutra.

Exemplo conceitual:

```ts
interface InboxTransport {
  receiveWebhook(payload): NormalizedMessageEvent
  sendMessage(ticketId, body): Promise<void>
  sendMedia(ticketId, media): Promise<void>
  getConversation(ticketId): Promise<ConversationSnapshot>
  listMessages(ticketId): Promise<Message[]>
  assignToHuman(ticketId, userId | queueId): Promise<void>
  closeConversation(ticketId): Promise<void>
  setLabelsOrTags(contactId, tags): Promise<void>
}
```

Implementações:

```txt
ChatwootTransport
WhazingTransport
```

## Gate de resposta no Whazing

O agente só deve responder quando todas as condições forem verdadeiras:

```txt
evento é mensagem inbound de cliente
AND fromMe == false
AND mensagem ainda não foi processada
AND ticket não está fechado
AND status permite bot
AND nenhum humano é dono do ticket
AND contato não tem disableBot/ignore
AND fila/canal está habilitado para IA
AND evento não é eco de mensagem enviada pela própria API
AND snapshot final antes do envio ainda permite resposta
```

Esse gate deve rodar duas vezes:

1. antes de executar LangGraph;
2. depois do modelo/ferramentas e antes de postar resposta.

## Prevenção de loop

Riscos:

- webhook de mensagem outbound disparar nova execução;
- API reenviar evento duplicado;
- agente responder mensagem dele mesmo;
- humano assumir ticket durante execução do modelo.

Controles necessários:

- dedupe por `messageId`;
- fallback por hash de `ticketId + timestamp + body`;
- `externalKey` determinístico em mensagens outbound;
- ignorar `fromMe == true`;
- ignorar eventos com `sendType`/metadata da nossa API;
- revalidar ticket imediatamente antes de responder.

## Thread/memória para Whazing

Não usar `ticketId` como chave principal, porque tickets podem fechar/reabrir. Preferir contato + canal.

Chave primária proposta:

```txt
tenant:<tenantId>:whazing:<instanceId>:channel:<whatsappId>:contact:<contactId>
```

Fallbacks:

```txt
tenant:<tenantId>:whazing:<instanceId>:number:<normalizedPhone>
tenant:<tenantId>:whazing:<instanceId>:ticket:<ticketId>
```

## Pontos técnicos críticos

### Webhook security

Validar se o Whazing oferece:

- assinatura HMAC;
- timestamp anti-replay;
- secret/header configurável;
- delivery id;
- retry semantics.

Se não houver assinatura nativa, implementar compensações:

- token secreto forte na rota;
- hash do token no banco;
- payload schema validation;
- payload size limit;
- rate limit por rota;
- dedupe;
- logs sem PII sensível;
- allowlist opcional de IP.

### API client

O client Whazing precisa cobrir:

- envio de texto por `ticketId` ou `number`;
- envio de mídia;
- consulta de ticket;
- criação/consulta/edição de contato;
- update de ticket;
- update de queue;
- update de chatbot quando aplicável;
- tags/CRM/follow-up quando habilitado.

Requisitos:

- schema validation em runtime;
- timeout;
- retries limitados;
- erro tipado;
- segredo redigido em logs;
- idempotência via `externalKey`.

### Media

Para multimodal, validar:

- se `mediaUrl` é acessível pelo backend;
- se precisa auth;
- se expira;
- tamanho máximo;
- MIME real;
- áudio/imagem/documento;
- risco SSRF.

Toda mídia deve passar por safe fetch antes de ir para STT/vision/LLM.

### Handoff

Handoff no Whazing provavelmente usa:

- `userId`;
- `queueId`;
- `updateticketinfo`;
- `updatequeue`.

Depois do handoff, gate deve impedir novas respostas.

### Multiempresa

Precisamos descobrir:

- como a empresa aparece no webhook;
- se token é por empresa/canal;
- se token consegue acessar outras empresas;
- como separar tenants;
- se há isolamento real na API.

### Licença

Antes de produção, validar:

- licença de uso;
- redistribuição;
- modificação;
- whitelabel;
- revenda;
- recursos premium;
- validação remota de licença;
- permissão para suportar Whazing publicamente.

## Issues criadas

- https://github.com/eudanielhenrique/agents/issues/1 — Epic: add Whazing as a first-class transport
- https://github.com/eudanielhenrique/agents/issues/2 — Design transport abstraction for Chatwoot and Whazing
- https://github.com/eudanielhenrique/agents/issues/3 — Add Whazing instance and credential model
- https://github.com/eudanielhenrique/agents/issues/4 — Implement Whazing API client
- https://github.com/eudanielhenrique/agents/issues/5 — Implement Whazing webhook receiver and event normalization
- https://github.com/eudanielhenrique/agents/issues/6 — Implement Whazing agent response gate
- https://github.com/eudanielhenrique/agents/issues/7 — Define Whazing memory thread keys
- https://github.com/eudanielhenrique/agents/issues/8 — Add Whazing handoff and ticket tools
- https://github.com/eudanielhenrique/agents/issues/9 — Support Whazing media ingestion and outbound media
- https://github.com/eudanielhenrique/agents/issues/10 — Add Whazing configuration API and UI
- https://github.com/eudanielhenrique/agents/issues/11 — Add Whazing integration test fixtures and contract tests
- https://github.com/eudanielhenrique/agents/issues/12 — Document Whazing setup and production hardening
- https://github.com/eudanielhenrique/agents/issues/13 — Validate Whazing licensing and deployment constraints
- https://github.com/eudanielhenrique/agents/issues/14 — Run Whazing proof-of-integration spike

## Ordem recomendada de execução

1. Validar licença e restrições comerciais.
2. Rodar spike real com uma instância Whazing.
3. Confirmar payloads reais de webhook e respostas da API.
4. Desenhar transport abstraction.
5. Criar modelo de instância/credenciais.
6. Implementar API client.
7. Implementar webhook receiver.
8. Implementar normalization + dedupe.
9. Implementar response gate.
10. Implementar outbound text.
11. Implementar handoff.
12. Implementar media.
13. Adicionar API/UI de configuração.
14. Cobrir com fixtures/contract tests.
15. Documentar setup e hardening.

## Prova mínima de integração

Checklist do spike:

- configurar Webhook de Canal;
- receber mensagem inbound;
- deduplicar por `messageId`;
- buscar ticket via API;
- rodar resposta fake sem LLM;
- enviar resposta por `ticketId`;
- confirmar que eco outbound não gera loop;
- transferir ticket para fila/usuário;
- confirmar que gate para de responder;
- testar ticket fechado;
- testar payload de mídia.

## Critério de viabilidade

Whazing vira alternativa real ao Chatwoot se o spike provar:

- webhook confiável;
- API suficiente para responder por ticket;
- leitura de ticket/histórico adequada;
- metadata suficiente para detectar humano vs bot;
- controle de fila/usuário suficiente para handoff;
- forma segura de evitar loop;
- mídia acessível com segurança;
- licença compatível com o produto.
