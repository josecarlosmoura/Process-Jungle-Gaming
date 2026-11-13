# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas de provedores de jogo e
debita/credita carteiras (`Wallet`) de jogadores com garantias de concorrência, idempotência e
auditabilidade. Decisões técnicas e trade-offs em `Documents/ARCHITECTURE.md`.

## O que já funciona

- `POST /wallets` — cria uma wallet para `playerId`+`currency`; saldo inicial positivo gera uma
  transação interna `OPENING` com lançamento `CREDIT` no ledger, na mesma transação SQL.
- `GET /wallets/:walletId` — consulta saldo, moeda e versão atuais.
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
    no futuro — primeiro passo do backoff) para o worker de reprocessamento (ainda não
    implementado) reler depois; repetir a mesma `Idempotency-Key` nesse estado nunca recalcula
    esses metadados.
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
- `GET /health/live`, `GET /health/ready` — liveness e readiness (Postgres + SQS).

## Setup local

```bash
cp .env.example .env               # ajuste se necessário; valores default já funcionam localmente
bun install
docker compose up -d               # Postgres + LocalStack (filas SQS)
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
bun run test:concurrency # cenário obrigatório de concorrência (test/concurrency/), paralelismo HTTP real
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
```
