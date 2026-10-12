# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Entradas sintetizadas a partir do `git log`; a ordem segue as tags de versão (`git log vX..vY`), não a data de autoria de cada commit — este repo mantém um branch proprietário de longa duração (a integração Whazing) que foi sincronizado com o upstream livre por um bom tempo antes de ser mesclado em `main`, então parte do trabalho abaixo tem data de commit bem anterior à tag em que ele efetivamente apareceu em `main`.

## [Unreleased]

A maior leva de mudanças do projeto até agora — ainda não tagueada. Inclui a fundação inteira do transporte Whazing (alternativa ao Chatwoot), integração logística/frete híbrido (Uber Direct + OSRM), configurador de agentes e a feature de memória entre conversas.

### Added
- **Transporte Whazing completo**: nova integração de WhatsApp paralela ao Chatwoot — modelos Prisma, webhook receiver com token de rota opaco, runtime do agente, ferramentas nativas (handoff/nota/encerrar), Kanban Pro (board/coluna no editor + ferramentas), mídia (STT de áudio + renderização de mensagem), painel de gestão na UI, i18n.
- **Hub de Frete e Entregas Híbrido**: integração de cotação e despacho via Uber Direct + OSRM gratuito, com actions de automação e toolpack para agentes.
- **Debounce + follow-ups + anamnese estruturada no Whazing**, em paridade com o Chatwoot: agrupamento de mensagens em rajada, reengajamento após período de inatividade, coleta de dados de triagem persistida no contato e reinjetada no prompt (corrige o agente repetir pergunta já respondida).
- **Roteamento de intake + marcação de campanha** portado de um fluxo n8n anterior para dentro do runtime (com desacoplamento de histórico e tags de anúncio).
- **Reconciliação diária de status de ticket** contra a Whazing via sweep.
- **Sincronização de histórico de conversa para o Langfuse** (Whazing).
- **KPIs de envolvimento/resolução no dashboard estendidos para Whazing** (antes só Chatwoot).
- **Memória entre conversas (`remember_fact`)**: nova ferramenta nativa, disponível em Chatwoot e Whazing, baseada no `store` do LangGraph (memória entre threads, distinta do checkpointer por-thread) — um agente lembra fatos curtos sobre um contato mesmo numa conversa nova.
- **Compartilhamento de playground sem login**: link público pra conversar com um agente.
- **Suite de testes de regressão de prompt.**
- **Toolpack Nuvemshop** (busca de pedido/produto) + fluxo de conexão OAuth self-service.
- Ferramenta HTTP: reply da fala pra voz (TTS) roda em modelo próprio e fica visível no log; ferramenta declara quais status HTTP são resultado, não falha; cap de resposta de tool HTTP subiu de 4000 para 20000 caracteres.

### Fixed
- Continuidade de memória do Whazing entre tickets do mesmo contato — thread não juntava por contato de verdade (campo errado lido do payload).
- `handoff_to_human` mandava a mensagem de fechamento pro cliente duas vezes.
- Whazing: parava de responder sozinho ao ver o eco da própria mensagem enviada; falha de roteamento de intake falhava aberto em vez de fechado; roteava a mensagem seguinte em vez da que disparou o evento; tratava texto puro como anexo fantasma; parava de responder por cima de atendente humano que acabou de responder manualmente; nota privada não vazava mais pro cliente; brecha TOCTOU na trava de turno em andamento.
- Log de auditoria não truncava mais o system prompt em 2k caracteres.
- Descoberta de metadata OAuth do MCP funcionando para servidores montados fora da raiz.

## [v1.14.1] - 2026-09-01
### Fixed
- Comunicação de limites de chamada de saída: bounds em chamadas externas para evitar que corpo travado trave o turno do agente (#465).
- Tratamento de cercas em verificações reavaliadas (#463).

## [v1.14.0] - 2026-09-01
### Added
- Ferramentas HTTP: permite selecionar quais campos da resposta JSON alcançam o modelo em vez de truncar os primeiros 4000 caracteres (#460).
- Leitura de turno assistente que carrega apenas reasoning como saída em vez de considerar turno vazio (#461).
- Trilha de auditoria expandida: registro no console para alterações de ferramentas, conexões, integrações, experimentos e templates (#399, #445).
### Fixed
- Tratamento do sentinela de pulo de follow-up como silêncio no fluxo reativo em vez de enviar ao cliente (#455).
- Prevenção de duplicidade em rajada via lock próprio para evitar que o re-engajamento repita mensagens (#451).
- Isolamento de credenciais próprias no endpoint de embeddings RAG sem alterar modelo (#448).
- Correção de `/reset` para não atuar sobre conversas limpas por turnos anteriores (#447).
- Registro do fim de atendimento humano além do início (#458).

## [v1.13.0] - 2026-08-28
### Added
- Recuperação de entregas presas: reprocessamento de entregas encalhadas por morte de processo (#380, #361).
- Rastreamento e auditoria de alterações de tenants, webhooks e canais de alerta direto do console (#409, #434).
- Suporte a leitura de PDFs com OpenAI (#348).
- Registro de raciocínio faturado de modelos além do texto de resposta (#336).
### Fixed
- Trava atômica durável para turnos em voo (in-flight fence) evitando condições de corrida multi-réplica (#366).
- Limite de consumo mensal de tokens por tenant antes de atingir faturas (#390).
- Descarte e limpeza correta de logs de fluxo emitidos (#385).
- Remoção do espelho de inboxes deletadas quando o canal é desvinculado (#341).
- Otimização de índices multi-tenant no Postgres removendo 18 índices redundantes (#384).

## [v1.12.0] - 2026-08-25
### Added
- Feedback detalhado e visual de recusa de validação nos inputs do console (#313).
- Registro de chamadas de modelo faturadas diretamente no ledger de auditoria (#322).
### Fixed
- Desvinculação graciosa de inboxes excluídas no Chatwoot sem travar chamadas subsequentes (#333).
- Aviso explícito quando uma inbox não possui agente associado (#332).
- Retirada de turnos recusados (reativos e proativos) do histórico de contexto do agente (#303, #323).
- Retentativa resiliente em falhas momentâneas de provedores de visão (#344).

## [v1.11.0] - 2026-08-25
### Added
- Portão externo de autorização de contato antes de cada turno (`contact authorization gate`) (#183).
- Emissão de templates de documentos autorados pelo agente anexados à resposta (#208).
### Fixed
- Tratamento de perda de conexão de pool sem descartar eventos de webhook (#237).
- Liberação imediata de transações pendentes em locks críticos de threads (#227).
- Sanitização de caracteres NUL e payloads corrompidos em linhas de log (#242).
- Proteção contra divisão indevida de caracteres multibyte em truncamentos (#217).

## [v1.10.0] - 2026-08-22
### Added
- Sumarização automática de atendimentos encerrados para consolidar memória do contato (#134, #191, #192).
- Schemas tipados para todos os blocos de configurações de agentes (#193).
- Dreno concorrente do scheduler de jobs compartilhados (#180).
### Fixed
- Mensagem final de handoff para atendimento humano tornada terminal (#159).
- Fila de mensagens em trânsito protegida contra descarte durante turnos ativos (#201).
- Métrica de resolução contabilizada estritamente onde o agente encerrou a conversa (#199).
- Remoção definitiva de coluna descontinuada `risk_tier` (#176, #212).

## [v1.9.0] - 2026-08-20
### Added
- Suporte a feriados, recessos e exceções de datas na grade de horários de atendimento (#148).
- Notificação direta ao cliente quando o atendimento estiver fechado por horário (#154).
- Isolamento de endpoints de credenciais em bucket dedicado no vault (#162).
- Delimitação do tamanho do histórico retornado para contatos frequentes (#127).
### Fixed
- Recusa estrita de configurações numéricas inválidas em vez de conversão silenciosa (#167).
- Rate limiters agora utilizam o cliente real em vez do IP do proxy reverso (#152).
- Relato visual no console quando guardrails não puderem ser executados (#135).

## [v1.8.0] - 2026-08-18
### Added
- Verificação simultânea de disponibilidade em todos os calendários autorizados (#116).
- Reescrita de resposta para áudio (TTS) com modelo dedicado para fala natural (#105).
- Pipeline de testes automatizados com execução contra banco Postgres real (#123).
### Fixed
- Atualização atômica de atributos customizados sem sobrescrever chaves adjacentes (#113).
- Autenticação e integridade do webhook da Asaas via header oficial (#107, #110).
- Re-ativação automática de agentes cujo backfill de follow-up havia sido bloqueado por RLS (#109).

## [v1.7.0] - 2026-08-17
### Added
- Guardrail de saída passa a ler a mensagem do cliente como checagem própria.
### Fixed
- Calendário único permitido não deixa mais o modelo inventar `calendarId`.
- Guardrail roda o modelo configurado em vez de falhar aberto quando o modelo vem vazio.

## [v1.6.0] - 2026-08-15
### Added
- `reasoning_effort` exposto por agente, no endpoint que já aceitava o campo.
### Fixed
- RAG: mantém o motivo de um documento bloqueado não ter sido indexado; console permite revisar sugestão antes de aprovar.
- Turno de agente morto agora é visível dentro do Chatwoot (antes, agente silencioso e agente quebrado pareciam iguais).
- Escrita de estado vinda do console não era mais desfeita por um evento do Chatwoot que já estava em trânsito.
- Indicador de follow-up não confia mais em job pendente que o handler vai descartar.
- Argumentos de tool chegam ao `ExecutionLog.detail` (documentado como livre de PII).
- `/reset` monta o client do Chatwoot com token de bot, corrigindo 401 ao limpar atributos customizados.

## [v1.5.0] - 2026-08-15
### Added
- Ferramenta para enviar imagem na conversa a partir de uma URL.
### Fixed
- Estado da conversa (Chatwoot) ordenado pelo `updated_at` do payload, pra um handoff sobreviver à própria cauda de mensagens.
- Família de modelos gpt-5.6 roda com reasoning effort "none" (tools paravam de ser aceitas).
- Indicador de follow-up respeita a pausa por compromisso ativo.
- Retry de chamada de modelo que voltou sem completion.
- Tools do Gemini declaradas como JSON Schema (limite numérico rejeitava todo turno).

## [v1.4.1] - 2026-08-12
### Fixed
- Mensagem de falha de TTS nomeia o formato de áudio e o código de erro do provedor.

## [v1.4.0] - 2026-08-10
### Fixed
- Gate de supersede no caminho direto + transcrição STT/vision sem a rota de meta do fork.
- Falha engolida em efeito colateral de tool vira linha de warn própria no log; falha de integração vira linha alertável.
- Supressão de follow-up por agendamento enxerga o compromisso após o último lembrete.
- Pino de localização do WhatsApp chega ao modelo com coordenadas.

## [v1.3.0] - 2026-08-09
### Fixed
- Sweep de follow-up aceita conversa dona de AgentBot, preservando o assignee no mirror.
- Follow-up não dispara mais em conversa já resolvida no Chatwoot.
- Lembrete e turnos seguintes carregam a identidade do evento de agenda.

## [v1.2.0] - 2026-08-06
### Added
- Atributos do Chatwoot selecionados pelo operador são injetados no prompt.
- URL do webhook volta a ficar legível no modal de edição.
### Fixed
- `calendar_create_event` cria sala do Meet e expõe `meetLink` no retorno.
- Container de áudio do TTS segue o canal de destino (Instagram recebe aac/wav, não ogg).
- Transcrição de áudio anexado passa a rodar após `message_created`.
- Retry no download de anexo do Chatwoot, com visibilidade de falha no flowlog.
- `temperature` não é mais enviada para modelos de raciocínio da OpenAI.

## [v1.1.1] - 2026-08-03
### Fixed
- Autoria programática de ferramentas HTTP aceita JSON Schema e `{var}` de chave simples.
- `resolve_conversation` diferido para depois do post da resposta final.
- `asaas_payment_status` consulta cobrança PIX direta; `create` devolve o `paymentId`.
- Webhook da Asaas aceita `null` em campos opcionais; payload inválido deixa rastro.

## [v1.1.0] - 2026-08-02
### Added
- Links do rodapé configuráveis (site, e-mail de suporte, GitHub ocultável).
- Guia de contribuição, CLA e documentação em inglês.
- Agendas de bloqueio respeitadas na checagem de disponibilidade.
### Fixed
- Espelho de inboxes reconcilia sozinho ao abrir a tela de canais.
- Watermark de mensagens tratadas avança em todo desfecho deliberado (Chatwoot).
- Ao editar um evento (dia inteiro ⇄ com horário), o campo de tempo oposto é limpo.

## [v1.0.0] - 2026-07-27
- Primeira versão pública, edição Free (Apache 2.0): fundação completa — runtime de agente sobre LangGraph, transporte Chatwoot, RLS multi-tenant, RAG, integrações, MCP server, painel operador.
