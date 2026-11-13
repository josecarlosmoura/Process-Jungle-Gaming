# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas de provedores de jogo e
debita/credita carteiras (`Wallet`) de jogadores com garantias de concorrência, idempotência e
auditabilidade. Decisões técnicas e trade-offs em `Documents/ARCHITECTURE.md`.

## O que já funciona

- `POST /wallets` — cria uma wallet para `playerId`+`currency`; saldo inicial positivo gera uma
  transação interna `OPENING` com lançamento `CREDIT` no ledger, na mesma transação SQL.
- `GET /wallets/:walletId` — consulta saldo, moeda e versão atuais.
- `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) — processa `kind: "BET"`:
  débito do saldo com lock pessimista por `walletId`, rejeição auditável por saldo insuficiente
  (`failureCode: "INSUFFICIENT_FUNDS"`) ou por moeda divergente (`failureCode:
  "CURRENCY_MISMATCH"`), replay idempotente por `Idempotency-Key` (inclusive para transações
  rejeitadas), e falha transitória de infraestrutura (`failureCode: "INTERNAL_ERROR"`, HTTP `503`)
  quando o lock da wallet não é obtido em 5s. Outros `kind` (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
  ainda não são suportados por este endpoint.
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
bun test                 # suíte completa (unidade + integração + e2e, requer Postgres/LocalStack no ar)
bun run test:unit        # exclui *.integration.spec.ts
bun run test:integration # só *.integration.spec.ts, isolado por arquivo
```

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
```
