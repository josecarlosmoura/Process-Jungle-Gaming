# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas de provedores de jogo e
debita/credita carteiras (`Wallet`) de jogadores com garantias de concorrência, idempotência e
auditabilidade. Decisões técnicas e trade-offs em `Documents/ARCHITECTURE.md`.

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
  ~150s de redelivery antes da DLQ, justificativa em `Documents/ARCHITECTURE.md` seção 2.2).
  `DlqMonitorScheduler` roda em toda instância e loga um aviso sempre que a DLQ tiver uma ou mais
  mensagens (`ApproximateNumberOfMessages`, sem consumir nem apagar nada dela — requer auditoria
  manual). Intervalo de polling configurável via `DLQ_MONITOR_POLL_INTERVAL_MS` (default `5000`).
- `GET /health/live`, `GET /health/ready` — liveness e readiness (Postgres + SQS).

## Setup local

```bash
cp .env.example .env               # ajuste se necessário; valores default já funcionam localmente
bun install
docker compose up -d               # Postgres + LocalStack (filas SQS) + SQS Admin (UI em http://localhost:3999)
bun run migration:up
bun run start:dev                  # sobe a API em http://localhost:3000
```

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

# processa uma BET (debita a wallet criada acima)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:bet-001" \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"<uuid>","walletId":"<wallet-id>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

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
