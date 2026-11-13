# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas de provedores de jogo e
debita/credita carteiras (`Wallet`) de jogadores com garantias de concorrência, idempotência e
auditabilidade. Decisões técnicas e trade-offs em `Documents/ARCHITECTURE.md`.

## O que já funciona

- `POST /wallets` — cria uma wallet para `playerId`+`currency`; saldo inicial positivo gera uma
  transação interna `OPENING` com lançamento `CREDIT` no ledger, na mesma transação SQL.
- `GET /wallets/:walletId` — consulta saldo, moeda e versão atuais.
- `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) — processa `kind: "BET"`,
  `"WIN"` e `"LOSS"`:
  - `BET`: débito do saldo com lock pessimista por `walletId`, rejeição auditável por saldo
    insuficiente (`failureCode: "INSUFFICIENT_FUNDS"`) ou por moeda divergente (`failureCode:
    "CURRENCY_MISMATCH"`).
  - `WIN`: crédito do saldo; aceita uma referência opcional a uma `BET` já processada da mesma
    rodada (`referenceExternalTransactionId`) — quando presente, precisa bater em
    provider/player/wallet/moeda/rodada e apontar para uma `BET` já `PROCESSED`, senão a `WIN`
    inteira é rejeitada (`failureCode: "REFERENCE_MISMATCH"`), sem creditar.
  - `LOSS`: não move saldo nem gera lançamento no ledger, mas ainda é uma transação `PROCESSED`
    auditável; também rejeita moeda divergente da wallet (`failureCode: "CURRENCY_MISMATCH"`).
  - Em qualquer `kind`: replay idempotente por `Idempotency-Key` (inclusive para transações
    rejeitadas), e falha transitória de infraestrutura (`failureCode: "INTERNAL_ERROR"`, HTTP
    `503`) quando o lock da wallet não é obtido em 5s. `REFUND`/`ROLLBACK` ainda não são
    suportados por este endpoint.
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
```
