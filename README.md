# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas de provedores de jogo e
debita/credita carteiras (`Wallet`) de jogadores com garantias de concorrência, idempotência e
auditabilidade. Decisões técnicas e trade-offs em `ARCHITECTURE.md`.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x (runtime e test runner do projeto).
- [Docker](https://www.docker.com/) e Docker Compose v2 (`docker compose`, não o binário legado
  `docker-compose`) — sobem Postgres, LocalStack (SQS) e, no setup completo, a própria aplicação.
- Nenhuma outra dependência precisa estar instalada no host: Node só é usado **dentro** da imagem
  Docker (ver `Dockerfile`), não é necessário no host para rodar o projeto.

## O que já funciona

- `POST /wallets` — cria uma wallet para `playerId`+`currency`; saldo inicial positivo gera uma
  transação interna `OPENING` com lançamento `CREDIT` no ledger, na mesma transação SQL.
- `GET /wallets/:walletId` — consulta saldo, moeda e versão atuais.
- `GET /wallets/:walletId/ledger?cursor=&limit=` — lista os lançamentos (`WalletLedgerEntry`) da
  wallet, ordenados por `createdAt` ascendente (desempate por `id`). `limit` default `50`, acima de
  `200` é clampado (nunca rejeitado); abaixo de `1` ou não-inteiro responde `400`. `cursor` é opaco
  e assinado (HMAC-SHA256) — nunca um `OFFSET` disfarçado, então uma inserção concorrente entre duas
  chamadas de paginação não repete nem pula itens. `nextCursor` vem preenchido em toda página não
  vazia (mesmo a última, parcial) — o cliente só descobre o fim ao receber uma página vazia.
  `404` para wallet inexistente, `400` para `walletId`/`cursor` inválidos.
- `POST /wallets/:walletId/reconciliation` — recalcula o saldo a partir do ledger inteiro (soma
  `CREDIT`/subtrai `DEBIT` via `Money`, nunca `number`, paginando internamente) e compara com o
  saldo materializado. Responde sempre `200` com `{walletId, storedBalance, calculatedBalance,
  difference, consistent, checkedEntries}` — a divergência nunca é corrigida automaticamente, só
  sinalizada: quando `consistent: false`, gera um log estruturado (nível `error`) e incrementa
  `ReconciliationMetrics.divergenceCount` (contador em memória, formalizado como métrica exposta
  só na T306). Leitura combinada (saldo + ledger) em uma única transação `REPEATABLE READ`, sem
  lock pessimista — não compete por lock com débito/crédito normal, mas também não lê um estado
  inconsistente entre as duas leituras. `404` para wallet inexistente, `400` para `walletId`
  inválido.
- `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) — processa `kind: "BET"`,
  `"WIN"`, `"LOSS"`, `"REFUND"` e `"ROLLBACK"`:
  - `BET`: débito do saldo com lock pessimista por `walletId`, rejeição auditável por saldo
    insuficiente (`failureCode: "INSUFFICIENT_FUNDS"`) ou por moeda divergente (`failureCode:
    "CURRENCY_MISMATCH"`).
  - `WIN`: crédito do saldo; aceita uma referência opcional a uma `BET` já processada da mesma
    rodada (`referenceExternalTransactionId`) — quando presente, precisa bater em
    provider/player/wallet/moeda/rodada e apontar para uma `BET` já `PROCESSED`, senão a `WIN`
    inteira é rejeitada (`failureCode: "REFERENCE_MISMATCH"`), sem creditar.
  - `LOSS`: não move saldo nem gera lançamento no ledger, mas ainda é uma transação `PROCESSED`
    auditável; também rejeita moeda divergente da wallet (`failureCode: "CURRENCY_MISMATCH"`).
  - `REFUND`: exige `referenceExternalTransactionId` (rejeitado como payload inválido se ausente)
    apontando para uma `BET` já `PROCESSED`, com o mesmo valor exato — credita o saldo de volta e
    grava a referência. Rejeita (`422`) por valor divergente (`failureCode:
    "REFERENCE_AMOUNT_MISMATCH"`), referência já revertida (`failureCode:
    "REFERENCE_ALREADY_REVERSED"`), referência de outro `kind`/grupo ou que nunca vai se tornar
    válida (`failureCode: "REFERENCE_MISMATCH"`/`"REFERENCE_NOT_FOUND"`). Quando a referência ainda
    não existe (ou ainda está em processamento), responde `202 Accepted` com `status:
    "PENDING_REFERENCE"` em vez de rejeitar, gravando `attempts = 0` e `next_attempt_at` (1 minuto
    no futuro — primeiro passo do backoff) para o **Pending-Reference Reprocessor Worker** reler
    depois; repetir a mesma `Idempotency-Key` nesse estado nunca recalcula esses metadados.
  - `ROLLBACK`: exige `referenceExternalTransactionId` apontando para uma `BET`, `WIN` ou
    `REFUND` já `PROCESSED` (nunca uma `LOSS`, que não afeta saldo), com o mesmo valor exato —
    aplica o efeito **inverso** ao da referência (credita de volta uma `BET`; debita de volta uma
    `WIN`/`REFUND`). Rejeita (`422`) pelos mesmos motivos do `REFUND`
    (`REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_MISMATCH`,
    `REFERENCE_NOT_FOUND`) e, de forma própria, quando o débito reverso levaria o saldo a negativo
    (`failureCode: "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE"`, distinto de `INSUFFICIENT_FUNDS`, que
    é exclusivo de `BET`). Referência ainda não existente também responde `202 Accepted` com
    `status: "PENDING_REFERENCE"`, com os mesmos metadados de reprocessamento do `REFUND`.
  - Em qualquer `kind`: replay idempotente por `Idempotency-Key` (inclusive para transações
    rejeitadas e para `PENDING_REFERENCE`), e falha transitória de infraestrutura (`failureCode:
    "INTERNAL_ERROR"`, HTTP `503`) quando o lock da wallet não é obtido em 5s.
  - Toda transação que chega a `PROCESSED`, é `REJECTED` ou entra em `PENDING_REFERENCE` (e também
    a `OPENING` gerada por `POST /wallets` com saldo inicial positivo) grava, na mesma transação
    SQL do efeito principal, uma ou mais linhas em `outbox_messages` (`WagerTransactionProcessed`,
    `WagerTransactionRejected`, `WalletBalanceChanged` — só quando o saldo de fato muda — e
    `WagerTransactionPendingReference`).
- `GET /wagering/transactions/:transactionId` — consulta o estado de uma transação pelo id
  interno: `status`, `kind`, `money` e, quando presentes, `referenceTransactionId` e (quando
  terminal) `failureCode`/`processedAt`. `404` para id inexistente, `400` para id malformado
  (não-UUID).
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — mesma consulta
  acima, pela chave de negócio do provedor `(providerId, externalTransactionId)` em vez do id
  interno; mesmo formato de resposta (mesma função de formatação). `404` quando a combinação não
  existir.
- **Outbox Publisher Worker** — roda em toda instância da aplicação (sem eleição de líder),
  reivindicando mensagens pendentes de `outbox_messages` via `FOR UPDATE SKIP LOCKED` e publicando
  cada uma na fila SQS `integration-events.fifo` (`MessageGroupId` = `aggregateId`,
  `MessageDeduplicationId` = `id` da mensagem). Sucesso grava `published_at`; falha agenda retry
  com backoff exponencial + jitter (`attempts`/`next_attempt_at`), sem limite de tentativas e sem
  derrubar o worker. Intervalo de polling e tamanho do lote configuráveis via
  `OUTBOX_PUBLISHER_POLL_INTERVAL_MS`/`OUTBOX_PUBLISHER_BATCH_SIZE` (defaults `2000`/`20`).
- **SQS Consumer** (`wager-transactions.fifo`) — segunda porta de entrada para operações de
  aposta, reutilizando exatamente o mesmo caso de uso do HTTP. Deduplica mensagens por
  `(consumerName, messageId)` em `inbox_messages`, numa única transação SQL com o efeito financeiro
  (mesma garantia de atomicidade da outbox). `ack` (remoção da mensagem) só acontece depois do
  commit; erro de negócio permanente (ex.: payload inválido, wallet inexistente) também é `ack`ado
  — nunca reentregue; erro transitório de infraestrutura nunca é `ack`ado, a mensagem volta à
  visibilidade da fila para retry. Processa uma mensagem por vez
  (`MaxNumberOfMessages: 1`); em `SIGTERM` (`app.enableShutdownHooks()`), para de buscar novas
  mensagens e aguarda a mensagem em andamento terminar antes do processo encerrar. Tempo de long
  polling configurável via `SQS_CONSUMER_WAIT_TIME_SECONDS` (default `10`, máximo `20`).
- **Pending-Reference Reprocessor Worker** — roda em toda instância (mesmo padrão sem eleição de
  líder do Outbox Publisher), reivindicando via `FOR UPDATE SKIP LOCKED` as `WagerTransaction`
  `PENDING_REFERENCE` cujo `next_attempt_at` já venceu e tentando resolver a referência de novo.
  Resolvida: aplica o efeito (crédito/débito, sob o mesmo lock pessimista da wallet de
  `POST /wagering/transactions`), marca `PROCESSED` e publica `WagerTransactionProcessed`/
  `WalletBalanceChanged`. Ainda não resolvida: agenda outra tentativa com backoff exponencial (1,
  2, 4, 8, 16, 30... minutos, teto de 30min) até **10 tentativas** ou **24h** desde a criação — o
  que ocorrer primeiro —, rejeitando então com `failureCode: "REFERENCE_NOT_FOUND"` e publicando
  `WagerTransactionRejected`. Uma referência que já terminou num estado definitivo inválido
  (`REJECTED`/`FAILED`, ou já revertida pelo mesmo tipo) rejeita de imediato, sem esperar esgotar
  tentativas/TTL. Intervalo de polling e tamanho do lote configuráveis via
  `PENDING_REFERENCE_REPROCESSOR_POLL_INTERVAL_MS`/`PENDING_REFERENCE_REPROCESSOR_BATCH_SIZE`
  (defaults `5000`/`20`).
- **DLQ** (`wager-transactions-dlq.fifo`) — redrive policy final: `maxReceiveCount=5` (no máximo
  ~150s de redelivery antes da DLQ, justificativa em `ARCHITECTURE.md` seção 2.2).
  `DlqMonitorScheduler` roda em toda instância e loga um aviso sempre que a DLQ tiver uma ou mais
  mensagens (`ApproximateNumberOfMessages`, sem consumir nem apagar nada dela — requer auditoria
  manual). Intervalo de polling configurável via `DLQ_MONITOR_POLL_INTERVAL_MS` (default `5000`).
- `GET /health/live`, `GET /health/ready` — liveness e readiness (Postgres + SQS).
- **Logs estruturados e `correlationId`** — todo log da aplicação sai como JSON (NDJSON) via
  `pino` (`app.useLogger()`, nenhum `console.log` em código de produção). Um `correlationId` é
  extraído do header `X-Correlation-Id` (HTTP) ou do atributo `correlationId` da mensagem (SQS) na
  borda — gerado quando ausente — e propagado por `AsyncLocalStorage` (`LogContextService`) por
  toda a operação, inclusive nos caminhos assíncronos (outbox publisher, reprocessador de
  referência pendente, cada um reaproveitando o `correlationId` da operação original). O log do
  desfecho de cada transação (`PROCESSED`/`REJECTED`/`PENDING_REFERENCE`/`FAILED`) inclui
  `correlationId`, `transactionId`, `walletId` e `providerId` — nunca `money`/o payload de entrada
  inteiro.
- `GET /metrics` — métricas Prometheus (`prom-client`, sem autenticação, mesmo nível dos health
  checks): `wager_transactions_total{status,kind}`, `wager_transaction_duration_seconds`,
  `idempotency_duplicates_total{channel}` (`http`/`inbox_sqs`), `retries_total` (outbox + reprocessador
  de referência pendente), `dlq_messages_total` (delta de polling do `DlqMonitorScheduler`, nunca
  consumindo a fila), `lock_wait_timeout_total`, e `outbox_lag_seconds` (Gauge, amostrado por um
  **ciclo de tempo próprio e independente** do Outbox Publisher Worker — continua subindo mesmo com o
  publisher pausado). Nenhuma métrica tem label de alta cardinalidade (nunca `playerId`/`walletId`/
  `transactionId`) nem influencia o resultado de nenhum caso de uso — são estritamente observacionais.
- **Observabilidade visual (Prometheus + Grafana + Loki/Promtail)** — extensão opcional (fora do
  escopo pontuado), subida junto do ambiente completo via `docker-compose.observability.yml`
  (incluído por `docker-compose.yml`). Prometheus faz *scrape* do `/metrics` das 3 réplicas; Loki +
  Promtail coletam os logs estruturados dos 3 containers `app-*` via o socket do Docker; Grafana já
  vem com os dois como *datasource* e com o dashboard "Distributed Wagering Processor - Overview"
  pré-provisionado (throughput por status/kind, latência p50/p95/p99, duplicatas de idempotência,
  retries/DLQ/lock-timeout, outbox lag, e um painel de logs das 3 réplicas) — nada a configurar na
  UI. Acesse em `http://localhost:${GRAFANA_PORT:-3001}` (login `admin`/`admin` por padrão).
  Detalhes em `ARCHITECTURE.md` seção 12.3.

## Setup local

Duas formas de rodar o projeto — escolha uma:

**A. Desenvolvimento (um único processo, hot-reload):**

```bash
cp .env.example .env               # ajuste se necessário; valores default já funcionam localmente
bun install
docker compose -f docker-compose.infra.yml up -d   # Postgres + LocalStack (filas SQS) + SQS Admin (UI em http://localhost:3999)
bun run migration:up
bun run start:dev                  # sobe a API em http://localhost:3000
```

**B. Ambiente completo (igual ao que um avaliador externo usa — 3 réplicas reais da aplicação
atrás de um nginx, RF-16/RNF-08):**

```bash
cp .env.example .env               # ajuste se necessário
docker compose up -d --build       # Postgres + LocalStack + migrations + app-1/app-2/app-3 + nginx + Prometheus/Grafana/Loki/Promtail
docker compose ps                  # confirma os 13 serviços saudáveis (2 one-shot "Exited (0)")
curl -s http://localhost/health/ready   # porta pública do nginx (${NGINX_PORT:-80})
```

Cada requisição ao nginx é repassada em round-robin para `app-1`/`app-2`/`app-3`; a resposta carrega
o header `X-Upstream-Addr` com a réplica que de fato respondeu (`curl -i` para ver os headers). Os
workers de fundo (Outbox Publisher, Pending-Reference Reprocessor, DLQ Monitor, consumer SQS) rodam
nas 3 réplicas — não existe um serviço "worker" separado.

## Comandos

```bash
bun run build            # typecheck (tsc)
bun run lint             # biome lint
bun run test             # suíte completa (unidade + integração + e2e, requer Postgres/LocalStack no ar)
bun run test:unit        # exclui *.integration.spec.ts
bun run test:integration # só *.integration.spec.ts, isolado por arquivo
bun run test:concurrency # 7 cenários obrigatórios de concorrência (test/concurrency/), paralelismo HTTP/SQS real
```

### Cenário de 3+ instâncias reais (`test/concurrency/multi-instance.spec.ts`)

Um dos 7 cenários de `test:concurrency` exige 3 processos físicos distintos da própria aplicação
(não 3 portas do mesmo processo). Antes de rodar `test:concurrency`, suba essa infraestrutura
dedicada (nunca ao mesmo tempo que `docker compose up` sozinho — os dois sobem os mesmos nomes de
container/volume para Postgres/LocalStack):

```bash
docker compose -f docker-compose.test.yml up -d --scale app=3
bun run test:concurrency
docker compose -f docker-compose.test.yml down
```

Esse arquivo (`docker-compose.test.yml`) é só para a suíte automatizada acima — descobre a porta
de host de cada réplica (`docker compose port --index <n> app 3000`) e fala direto com elas, sem
load balancer. Para repetir manualmente o mesmo tipo de cenário (2 `BET`s em paralelo, 50 POSTs
idênticos) contra o ambiente final com nginx, use o setup B da seção "Setup local" acima e aponte
para `http://localhost:${NGINX_PORT:-80}` em vez de uma réplica direta.

Sempre use `bun run test`/`test:*` (nunca `bun test` direto): vários specs mutam `process.env`
e fazem `import()` dinâmico do `AppModule` para simular dependências fora do ar (ex.: Postgres
inacessível) — sem a flag `--isolate`, que os scripts acima já carregam, todos os arquivos rodam
no mesmo processo e esse `process.env` vaza de um arquivo para o outro, quebrando testes que nada
têm a ver com a mudança feita.

## Exemplo rápido

```bash
# cria wallet com saldo inicial
curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"<uuid>","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# processa uma BET (debita a wallet criada acima) - com um correlationId proprio, para rastrear
# nos logs (se omitido, a aplicacao gera um)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:bet-001" \
  -H "X-Correlation-Id: minha-trace-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# confere o log estruturado da BET acima (rode a app com `bun run start:dev | tee /tmp/app.log`)
grep '"correlationId":"minha-trace-001"' /tmp/app.log | jq .
# esperado: uma linha JSON com event=wager_transaction_outcome, status=PROCESSED,
# transactionId/walletId/providerId preenchidos - nunca "money" nem o payload de entrada inteiro

# confere as metricas Prometheus (a BET acima ja incrementou wager_transactions_total)
curl -s http://localhost:3000/metrics | grep -E "wager_transactions_total|idempotency_duplicates_total|outbox_lag|dlq_messages_total"

# consulta a BET acima pelo id interno (transactionId devolvido no POST acima)
curl -i http://localhost:3000/wagering/transactions/<transaction-id-da-bet>

# mesma consulta, agora pela chave de negocio do provedor (sem precisar do id interno)
curl -i http://localhost:3000/providers/provider-a/wagering/transactions/bet-001

# lista o ledger da wallet paginado (o lancamento DEBIT da BET acima aparece aqui)
curl -s "http://localhost:3000/wallets/<wallet-id>/ledger?limit=2" | tee /tmp/page1.json
CURSOR=$(jq -r '.nextCursor' /tmp/page1.json)
curl -s "http://localhost:3000/wallets/<wallet-id>/ledger?cursor=$CURSOR&limit=2"

# reconciliacao: saldo materializado deve bater com o recalculado a partir do ledger
curl -i -X POST http://localhost:3000/wallets/<wallet-id>/reconciliation
# esperado: consistent=true, difference 0.00

# divergencia artificial (so para teste - nunca fazer isso em produção)
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "update wallets set balance_amount = balance_amount + 1 where id = '<wallet-id>';"
curl -i -X POST http://localhost:3000/wallets/<wallet-id>/reconciliation
# esperado: consistent=false, difference {"amount":"1.00",...}; log de erro na aplicacao;
# o saldo no banco permanece divergente (nunca corrigido automaticamente)
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "update wallets set balance_amount = balance_amount - 1 where id = '<wallet-id>';"  # reverte

# processa um WIN referenciando a BET acima (credita a wallet)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:win-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"win-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'

# processa um LOSS (não move saldo, mas fica PROCESSED)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:loss-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"loss-002","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-2","gameId":"fortune-chimp","kind":"LOSS","money":{"amount":"10.00","currency":"BRL"}}'

# processa um REFUND da BET acima (credita a wallet de volta pelo mesmo valor)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:refund-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"25.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'

# processa um ROLLBACK do WIN acima (debita a wallet - efeito inverso ao da WIN)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:rollback-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"rollback-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp","kind":"ROLLBACK","money":{"amount":"50.00","currency":"BRL"},"referenceExternalTransactionId":"win-001"}'

# cenario "fora de ordem": ROLLBACK referenciando uma BET que ainda nao existe
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:rollback-fora-ordem-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"rollback-fora-ordem-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-3","gameId":"fortune-chimp","kind":"ROLLBACK","money":{"amount":"30.00","currency":"BRL"},"referenceExternalTransactionId":"bet-fora-ordem-001"}'
# esperado: 202 Accepted, status PENDING_REFERENCE

# agora a BET referenciada chega
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:bet-fora-ordem-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-fora-ordem-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-3","gameId":"fortune-chimp","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
# esperado: 201, status PROCESSED

# aguarde o nextAttemptAt (1min por padrao) e um ciclo do worker (PENDING_REFERENCE_REPROCESSOR_POLL_INTERVAL_MS, default 5s)
sleep 65
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "select status, reference_transaction_id, attempts from wager_transactions where idempotency_key = 'provider-a:rollback-fora-ordem-001';"
# esperado: status PROCESSED, reference_transaction_id apontando para a BET acima - sem nenhuma nova chamada HTTP/SQS alem das duas acima

# confere os eventos de integração gravados na outbox para a wallet acima - published_at e
# preenchido em ate um ciclo de polling (OUTBOX_PUBLISHER_POLL_INTERVAL_MS, default 2s) pelo
# Outbox Publisher Worker, que roda em background na propria aplicacao
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "select event_type, aggregate_id, occurred_at, published_at from outbox_messages where aggregate_id = '<wallet-id>' order by occurred_at;"

# confere a mensagem publicada de fato no SQS (integration-events.fifo)
aws --endpoint-url=http://localhost:4566 sqs receive-message \
  --queue-url "$(aws --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name integration-events.fifo --query QueueUrl --output text)" \
  --attribute-names All

# publica uma BET via fila (segunda porta de entrada, mesmo efeito que o curl HTTP acima)
QUEUE_URL=$(aws --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url "$QUEUE_URL" \
  --message-group-id "<wallet-id>" \
  --message-deduplication-id "msg-sqs-001" \
  --message-body '{"messageId":"msg-sqs-001","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"bet-sqs-001","idempotencyKey":"provider-a:bet-sqs-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-sqs-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"15.00","currency":"BRL"}}}'

sleep 2
curl -s http://localhost:3000/wallets/<wallet-id>   # saldo debitado em 15.00

# reenviar a MESMA mensagem de negócio (mesmo "messageId" no corpo, outro MessageDeduplicationId
# simulando uma redelivery real) nao debita de novo
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url "$QUEUE_URL" \
  --message-group-id "<wallet-id>" \
  --message-deduplication-id "msg-sqs-001-retry" \
  --message-body '{"messageId":"msg-sqs-001", ... mesmo corpo de data ...}'
sleep 2
curl -s http://localhost:3000/wallets/<wallet-id>   # saldo inalterado

# SIGTERM gracioso: para de buscar nova mensagem, conclui a que estiver em andamento
# (rodando fora do docker compose, ex.: `bun run start:dev` ou `node dist/main.js`)
kill -TERM <pid-do-processo-node>
# log esperado antes do processo encerrar:
# "[WagerTransactionSqsConsumer] parando de receber novas mensagens de wager-transactions.fifo"

# DLQ: forcar uma falha permanente (infraestrutura indisponivel) e confirmar que a mensagem
# aparece na DLQ apos maxReceiveCount=5 entregas, e que o DlqMonitorScheduler loga um aviso quando
# isso acontece. <wallet-id> precisa ser o id REAL de uma wallet ja criada (ex.: a do primeiro
# exemplo acima) - um placeholder literal falha a validacao do envelope (nao e um uuid) e a
# mensagem e descartada na hora, sem nunca chegar a tentar o Postgres nem a DLQ.
docker compose stop postgres
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url "$QUEUE_URL" \
  --message-group-id "dlq-demo" \
  --message-deduplication-id "msg-dlq-demo-001" \
  --message-body '{"messageId":"msg-dlq-demo-001","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"bet-dlq-demo-001","idempotencyKey":"provider-a:bet-dlq-demo-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-dlq-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'

# IMPORTANTE: so reiniciar o Postgres DEPOIS de confirmar a mensagem na DLQ, nunca antes - o SQS
# so decide mover a mensagem de forma lazy, na tentativa de receive SEGUINTE a esgotar
# maxReceiveCount (nao no instante exato em que a 5a entrega termina), entao o tempo real passa
# um pouco de 5 x 30s=150s; reiniciar o Postgres cedo demais deixa essa tentativa seguinte
# processar a mensagem com sucesso em vez de desvia-la, e ela nunca chega a DLQ.
DLQ_URL=$(aws --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
for i in $(seq 1 24); do
  result=$(aws --endpoint-url=http://localhost:4566 sqs receive-message --queue-url "$DLQ_URL" --attribute-names All)
  if [ -n "$result" ]; then
    echo "$result"
    break
  fi
  sleep 10
done
# esperado (dentro de uns 180-220s): a mensagem aparece acima - nunca reprocessada
# automaticamente (requer auditoria manual). Nos logs da aplicacao, esperado:
# "[DlqMonitorScheduler] 1 mensagem(ns) detectada(s) em wager-transactions-dlq.fifo - requer auditoria manual"
docker compose start postgres
```

## Troubleshooting

- **LocalStack não sobe (`localstack` nunca fica `healthy`, `curl http://localhost:4566/_localstack/health`
  falha):** normalmente é memória/CPU insuficiente para o container no host, ou uma imagem anterior
  corrompida. Confira `docker compose logs localstack`; `docker compose down -v` seguido de
  `docker compose -f docker-compose.infra.yml up -d` (ou `docker compose up -d --build` no setup
  completo) costuma resolver — isso recria os volumes, então não use em um ambiente com dado que
  você queira manter.
- **`localstack-init` falha ou as filas não existem (`sqs get-queue-url` devolve erro
  `QueueDoesNotExist`):** o serviço `localstack-init` só roda depois de `localstack` ficar saudável
  (`depends_on: service_healthy`); se `localstack` demorou mais que o esperado para subir, rode
  `docker compose up -d localstack-init` de novo manualmente — ele é idempotente (recriar uma fila
  que já existe não falha).
- **Migration falha com porta ocupada (`EADDRINUSE`/`bind: address already in use`, geralmente na
  porta `5432` do Postgres ou `4566` do LocalStack):** outra instância do Postgres/LocalStack (deste
  projeto ou de outro) já está usando a porta no host. Pare o processo conflitante ou mude a porta
  publicada em `.env` (`DB_PORT`, `NGINX_PORT`, `SQS_ADMIN_PORT`) — as portas *internas* do container
  não mudam, só a publicada no host.
- **`migrate` e `docker-compose.test.yml` disputando os mesmos containers:** `docker-compose.yml` e
  `docker-compose.test.yml` sobem Postgres/LocalStack com os mesmos nomes de container/volume
  (ambos via `docker-compose.infra.yml`) — nunca os rode ao mesmo tempo. Pare um (`docker compose
  down`) antes de subir o outro.
- **`bun test` roda mas falha de forma incoerente (um arquivo passa isolado, mas falha dentro da
  suíte completa):** use sempre `bun run test`/`test:unit`/`test:integration`/`test:concurrency`
  (nunca `bun test` direto) — a flag `--isolate` que esses scripts carregam evita que o
  `process.env` mutado por um spec vaze para outro no mesmo processo (ver seção "Comandos" acima).
- **`docker compose ps` mostra uma réplica (`app-1`/`app-2`/`app-3`) ou o `nginx` sem ficar
  `healthy`:** confira `docker compose logs app-1` (troque o nome do serviço) — a causa mais comum é
  o serviço `migrate` não ter terminado com sucesso ainda (`docker compose ps migrate` deve mostrar
  `Exited (0)`) ou uma variável de `.env` ausente/incorreta (`LEDGER_CURSOR_SECRET`, credenciais do
  Postgres).
