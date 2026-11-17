# Roteiro de Testes Manuais — Distributed Wagering Processor

Este roteiro cobre, em sequência lógica, todas as situações que o sistema suporta hoje
(estado do código na branch `feature/implementacao-observabilidade`, após T308). Siga a ordem —
cada fase depende do estado deixado pela anterior (saldos, ids de wallet/transação).

As chamadas HTTP são feitas no **Postman** (manualmente, ou importando a collection pronta —
veja a seção "Collection Postman" no final). O envio de mensagens para a fila SQS é feito no
**CMD do Windows** (`cmd.exe`), com `aws-cli` apontando para o LocalStack. Comandos de verificação
no Postgres também rodam no CMD, via `docker compose exec`.

## Convenção usada neste documento

- `<WALLET_ID_W1>`, `<WALLET_ID_W2>`, `<TRANSACTION_ID_xxx>` — valores que só existem depois que
  o request correspondente responder. Anote o `id` retornado e substitua nas chamadas seguintes.
- Todo header `Content-Type: application/json` é implícito em todo `POST` — adicione sempre.
- `BASE_URL = http://localhost` (porta 80 do nginx, ambiente completo — ver Fase 0). Se você
  mudou `NGINX_PORT` no `.env`, ajuste.

---

## FASE 0 — Subir 100% do ambiente local (3 réplicas + nginx)

Ambiente "igual ao que um avaliador externo usa" (`README.md` seção "Setup local", opção B).

1. **Pré-requisitos no host Windows:**
   - [Docker Desktop](https://www.docker.com/) instalado e rodando (Docker Compose v2 — `docker compose`, não `docker-compose`).
   - **AWS CLI v2** instalado no Windows (não dentro de container) — necessário para a Fase 12/13
     (envio de mensagens SQS via CMD). Verifique com:
     ```
     aws --version
     ```
   - Nenhuma outra dependência é necessária no host — Bun/Node só rodam dentro das imagens Docker.

2. **Configurar credenciais fake da AWS CLI** (LocalStack aceita qualquer valor, mas a CLI exige que
   algo esteja definido). No CMD, uma vez por sessão:
   ```
   set AWS_ACCESS_KEY_ID=test
   set AWS_SECRET_ACCESS_KEY=test
   set AWS_DEFAULT_REGION=us-east-1
   ```

3. **Variáveis de ambiente do projeto** (na raiz `C:\Projetos\JG`):
   ```
   copy .env.example .env
   ```
   Os valores default já funcionam localmente — não precisa editar.

4. **Subir o ambiente completo** (Postgres + LocalStack + migrations + app-1/app-2/app-3 + nginx):
   ```
   docker compose up -d --build
   ```
   Aguarde todos os serviços ficarem saudáveis:
   ```
   docker compose ps
   ```
   **Esperado:** 9 serviços; `migrate` e `localstack-init` com status `Exited (0)`; os demais
   (`postgres`, `localstack`, `sqs-admin`, `app-1`, `app-2`, `app-3`, `nginx`) com `(healthy)`.
   Se algum não ficar saudável, veja a seção "Troubleshooting" do `README.md` antes de continuar.

5. **Smoke test de que o ambiente está de pé** — vá para a Fase 1 abaixo.

> **UI auxiliares disponíveis durante os testes:**
> - SQS Admin (visualizar filas/mensagens): http://localhost:3999
> - Grafana (dashboard "Distributed Wagering Processor - Overview", métricas E logs das 3
>   réplicas já provisionados): http://localhost:3001 (login `admin`/`admin`) — alternativa visual
>   a `docker compose logs -f app-1`/`GET /metrics` para acompanhar as Fases 4-16 em tempo real.
> - Prometheus (consultas PromQL ad-hoc): http://localhost:9090
> - Para ver logs de uma réplica específica via terminal: `docker compose logs -f app-1` (troque
>   `app-1` por `app-2`/`app-3`/`nginx` conforme necessário).

---

## FASE 1 — Health checks e Metrics (smoke test)

### TM-01 — Liveness
```
GET {{BASE_URL}}/health/live
```
**Esperado:** `200 OK`, body `{"status":"ok"}`.

### TM-02 — Readiness
```
GET {{BASE_URL}}/health/ready
```
**Esperado:** `200 OK`, body `{"status":"ok","postgres":"up","sqs":"up"}`.

### TM-03 — Métricas (estado inicial)
```
GET {{BASE_URL}}/metrics
```
**Esperado:** `200 OK`, `Content-Type: text/plain; ...`, corpo no formato Prometheus contendo
(entre outras) as séries `wager_transactions_total`, `wager_transaction_duration_seconds`,
`idempotency_duplicates_total`, `retries_total`, `dlq_messages_total`, `lock_wait_timeout_total`,
`outbox_lag_seconds`. Guarde este resultado para comparar com a Fase 16 (métricas finais).

---

## FASE 2 — Criação de Wallets

### TM-04 — Criar wallet COM saldo inicial (Carteira Principal — W1)
```
POST {{BASE_URL}}/wallets
Content-Type: application/json

{
  "playerId": "player-principal",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```
**Esperado:** `201 Created`.
```json
{ "id": "<WALLET_ID_W1>", "playerId": "player-principal", "balance": {"amount":"1000.00","currency":"BRL"}, "version": 1 }
```
📌 **Anote `<WALLET_ID_W1>`** — usado em quase todo o resto do roteiro.

### TM-05 — Criar wallet SEM saldo inicial (Carteira Zerada — W2)
```
POST {{BASE_URL}}/wallets
Content-Type: application/json

{
  "playerId": "player-zerada",
  "initialBalance": { "amount": "0.00", "currency": "BRL" }
}
```
**Esperado:** `201 Created`, `balance.amount: "0.00"`, `version: 1`.
📌 **Anote `<WALLET_ID_W2>`**.

### TM-06 — Payload inválido: `playerId` ausente
```
POST {{BASE_URL}}/wallets
Content-Type: application/json

{ "initialBalance": { "amount": "100.00", "currency": "BRL" } }
```
**Esperado:** `400 Bad Request` (mensagem citando `playerId`).

### TM-07 — Payload inválido: moeda fora do formato (3 letras maiúsculas)
```
POST {{BASE_URL}}/wallets
Content-Type: application/json

{ "playerId": "player-moeda-invalida", "initialBalance": { "amount": "100.00", "currency": "brl" } }
```
**Esperado:** `400 Bad Request` (mensagem citando `initialBalance.currency`).

### TM-08 — Conflito: wallet duplicada (mesmo `playerId` + moeda de W1)
```
POST {{BASE_URL}}/wallets
Content-Type: application/json

{ "playerId": "player-principal", "initialBalance": { "amount": "1.00", "currency": "BRL" } }
```
**Esperado:** `409 Conflict`, `{"failureCode":"IDEMPOTENCY_CONFLICT"...}` **não** — confira que o
body tenha `message` citando que já existe wallet para `playerId`/`currency` (sem `failureCode`,
pois `WalletAlreadyExistsError` não carrega um — apenas confirme o status `409`).

---

## FASE 3 — Consulta de Wallet

### TM-09 — Consultar W1
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>
```
**Esperado:** `200 OK`, `balance.amount: "1000.00"`, `version: 1`.

### TM-10 — Consultar W2
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W2>
```
**Esperado:** `200 OK`, `balance.amount: "0.00"`, `version: 1`.

### TM-11 — Wallet inexistente (UUID válido, mas não cadastrado)
```
GET {{BASE_URL}}/wallets/00000000-0000-0000-0000-000000000000
```
**Esperado:** `404 Not Found`.

### TM-12 — `walletId` malformado (não é UUID)
```
GET {{BASE_URL}}/wallets/nao-e-um-uuid
```
**Esperado:** `400 Bad Request`.

### TM-13 — Ledger de W2 (deve estar vazio — saldo inicial era zero, sem `OPENING`)
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W2>/ledger
```
**Esperado:** `200 OK`, `{"entries": []}` (sem `nextCursor`).

### TM-14 — Crédito em W2 via `WIN` sem referência (prepara W2 para a Fase 12 — mensageria)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-b:win-w2-credito-001

{
  "providerId": "provider-b",
  "externalTransactionId": "win-w2-credito-001",
  "playerId": "player-zerada",
  "walletId": "<WALLET_ID_W2>",
  "roundId": "round-w2-credito-1",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "200.00", "currency": "BRL" }
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "200.00"`.
📌 Saldo de W2 agora é **200.00 BRL**.

---

## FASE 4 — Fluxo principal de transações (sobre W1)

Saldo de W1 no início desta fase: **1000.00 BRL**.

### TM-15 — `BET` (débito)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-001

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "100.00", "currency": "BRL" }
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "900.00"`.
📌 **Anote `<TRANSACTION_ID_BET_001>`** (campo `transactionId`).

### TM-16 — `WIN` referenciando a BET acima (crédito)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:win-001

{
  "providerId": "provider-a",
  "externalTransactionId": "win-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "150.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-001"
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "1050.00"`.
📌 **Anote `<TRANSACTION_ID_WIN_001>`**.

### TM-17 — `LOSS` (não move saldo, mas fica `PROCESSED`)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:loss-001

{
  "providerId": "provider-a",
  "externalTransactionId": "loss-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "LOSS",
  "money": { "amount": "20.00", "currency": "BRL" }
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "1050.00"` (inalterado).

### TM-18 — `REFUND` da BET (crédito de volta, valor exato)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-001

{
  "providerId": "provider-a",
  "externalTransactionId": "refund-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "100.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-001"
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "1150.00"`.

### TM-19 — `ROLLBACK` do WIN (efeito inverso: débito)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:rollback-001

{
  "providerId": "provider-a",
  "externalTransactionId": "rollback-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "ROLLBACK",
  "money": { "amount": "150.00", "currency": "BRL" },
  "referenceExternalTransactionId": "win-001"
}
```
**Esperado:** `201 Created`, `status: "PROCESSED"`, `balance.amount: "1000.00"`.
📌 Saldo de W1 volta a **1000.00 BRL** — fim da Fase 4.

---

## FASE 5 — Idempotência

### TM-20 — Replay exato do TM-15 (mesma `Idempotency-Key`, mesmo payload)
Repita **exatamente** a chamada do TM-15 (mesmo header, mesmo body, byte a byte).

**Esperado:** `200 OK` (não `201`!) — `idempotentReplay: true`, `status: "PROCESSED"`,
`balance.amount: "900.00"` (o saldo **congelado no momento original** daquela transação — não o
saldo atual de 1000.00). O saldo real de W1 continua **1000.00**, confirme com um
`GET {{BASE_URL}}/wallets/<WALLET_ID_W1>` em paralelo.

### TM-21 — Conflito de idempotência (mesma `Idempotency-Key`, payload diferente)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-001

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "999.00", "currency": "BRL" }
}
```
**Esperado:** `409 Conflict`, `{"failureCode":"IDEMPOTENCY_CONFLICT", "message": "..."}`.

---

## FASE 6 — Rejeições de negócio (`failureCode`)

Saldo de W1 no início: **1000.00 BRL**.

### TM-22 — `INSUFFICIENT_FUNDS`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-002

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-002",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-002",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "5000.00", "currency": "BRL" }
}
```
**Esperado:** `422 Unprocessable Entity`, `status: "REJECTED"`, `failureCode: "INSUFFICIENT_FUNDS"`,
`balance.amount: "1000.00"` (inalterado).

### TM-23 — `CURRENCY_MISMATCH`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-003

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-003",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-003",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "USD" }
}
```
**Esperado:** `422`, `status: "REJECTED"`, `failureCode: "CURRENCY_MISMATCH"`, `balance.amount: "1000.00"`.

### TM-24 — Nova `BET` válida (base para os próximos testes de referência)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-004

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-004",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-004",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "50.00", "currency": "BRL" }
}
```
**Esperado:** `201`, `status: "PROCESSED"`, `balance.amount: "950.00"`.

### TM-25 — `REFERENCE_MISMATCH` via `WIN` (referência não bate no `roundId`)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:win-003

{
  "providerId": "provider-a",
  "externalTransactionId": "win-003",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-003-diferente",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "500.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-004"
}
```
**Esperado:** `422`, `failureCode: "REFERENCE_MISMATCH"`, `balance.amount: "950.00"` (inalterado —
a `BET` de referência existe e está `PROCESSED`, mas o `roundId` enviado não bate com o da `bet-004`).

### TM-26 — `REFERENCE_MISMATCH` via `REFUND` (referência de `kind` não aceito)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-002

{
  "providerId": "provider-a",
  "externalTransactionId": "refund-002",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "150.00", "currency": "BRL" },
  "referenceExternalTransactionId": "win-001"
}
```
**Esperado:** `422`, `failureCode: "REFERENCE_MISMATCH"` (`REFUND` só aceita referenciar uma `BET`,
nunca uma `WIN`), `balance.amount: "950.00"`.

### TM-27 — `REFERENCE_AMOUNT_MISMATCH`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-003

{
  "providerId": "provider-a",
  "externalTransactionId": "refund-003",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-004",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "999.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-004"
}
```
**Esperado:** `422`, `failureCode: "REFERENCE_AMOUNT_MISMATCH"` (a `bet-004` vale `50.00`, não
`999.00`), `balance.amount: "950.00"`.

### TM-28 — `REFERENCE_ALREADY_REVERSED`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-004

{
  "providerId": "provider-a",
  "externalTransactionId": "refund-004",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "100.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-001"
}
```
**Esperado:** `422`, `failureCode: "REFERENCE_ALREADY_REVERSED"` (`bet-001` já foi revertida pelo
`refund-001` no TM-18), `balance.amount: "950.00"`.

### TM-29 — `WIN` válida (prepara o próximo teste — rollback que vai ficar negativo)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:win-002

{
  "providerId": "provider-a",
  "externalTransactionId": "win-002",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-004",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "500.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-004"
}
```
**Esperado:** `201`, `status: "PROCESSED"`, `balance.amount: "1450.00"`.
📌 **Anote `<TRANSACTION_ID_WIN_002>`** (não é necessário, mas fica disponível para consulta na Fase 9).

### TM-30 — Nova `BET` grande (deixa o saldo baixo de propósito)
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-005

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-005",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-005",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "1400.00", "currency": "BRL" }
}
```
**Esperado:** `201`, `status: "PROCESSED"`, `balance.amount: "50.00"`.

### TM-31 — `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:rollback-002

{
  "providerId": "provider-a",
  "externalTransactionId": "rollback-002",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-004",
  "gameId": "fortune-chimp",
  "kind": "ROLLBACK",
  "money": { "amount": "500.00", "currency": "BRL" },
  "referenceExternalTransactionId": "win-002"
}
```
**Esperado:** `422`, `failureCode: "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE"` (debitar `500.00` de um
saldo de `50.00` ficaria negativo), `balance.amount: "50.00"` (inalterado).
📌 Saldo final de W1 ao fim da Fase 6: **50.00 BRL**.

---

## FASE 7 — Validações `400` adicionais em `/wagering/transactions`

Nenhum destes afeta saldo (todos rejeitados antes de abrir transação de negócio).

### TM-32 — Sem header `Idempotency-Key`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json

{
  "providerId": "provider-a", "externalTransactionId": "bet-sem-idem-001", "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>", "roundId": "round-x", "gameId": "fortune-chimp", "kind": "BET",
  "money": { "amount": "1.00", "currency": "BRL" }
}
```
**Esperado:** `400 Bad Request` (mensagem: header `Idempotency-Key` é obrigatório).

### TM-33 — `kind` não suportado
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:deposit-001

{
  "providerId": "provider-a", "externalTransactionId": "deposit-001", "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>", "roundId": "round-x", "gameId": "fortune-chimp", "kind": "DEPOSIT",
  "money": { "amount": "1.00", "currency": "BRL" }
}
```
**Esperado:** `400 Bad Request` (`kind "DEPOSIT" is not supported yet`).

### TM-34 — `REFUND` sem `referenceExternalTransactionId`
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:refund-sem-ref-001

{
  "providerId": "provider-a", "externalTransactionId": "refund-sem-ref-001", "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>", "roundId": "round-x", "gameId": "fortune-chimp", "kind": "REFUND",
  "money": { "amount": "1.00", "currency": "BRL" }
}
```
**Esperado:** `400 Bad Request` (`referenceExternalTransactionId is required for kind "REFUND"`).

### TM-35 — `walletId` malformado no body
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-wallet-invalido-001

{
  "providerId": "provider-a", "externalTransactionId": "bet-wallet-invalido-001", "playerId": "player-principal",
  "walletId": "nao-e-um-uuid", "roundId": "round-x", "gameId": "fortune-chimp", "kind": "BET",
  "money": { "amount": "1.00", "currency": "BRL" }
}
```
**Esperado:** `400 Bad Request`.

### TM-36 — `transactionId` malformado na consulta
```
GET {{BASE_URL}}/wagering/transactions/nao-e-um-uuid
```
**Esperado:** `400 Bad Request`.

### TM-37 — Transação inexistente (UUID válido, não cadastrado)
```
GET {{BASE_URL}}/wagering/transactions/00000000-0000-0000-0000-000000000000
```
**Esperado:** `404 Not Found`.

---

## FASE 8 — Referência pendente fora de ordem (`PENDING_REFERENCE`)

Saldo de W1 no início: **50.00 BRL**.

### TM-38 — `ROLLBACK` referenciando uma `BET` que ainda não existe
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:rollback-fora-ordem-001

{
  "providerId": "provider-a",
  "externalTransactionId": "rollback-fora-ordem-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-fora-ordem-1",
  "gameId": "fortune-chimp",
  "kind": "ROLLBACK",
  "money": { "amount": "30.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-fora-ordem-001"
}
```
**Esperado:** `202 Accepted`, `status: "PENDING_REFERENCE"`, `balance.amount: "50.00"` (inalterado —
nada foi debitado/creditado ainda).
📌 **Anote `<TRANSACTION_ID_ROLLBACK_FORA_ORDEM>`**.

### TM-39 — Verifique no banco que ficou agendada para reprocessamento
```
docker compose exec postgres psql -U wagering -d wagering_dev -c "select status, attempts, next_attempt_at from wager_transactions where idempotency_key = 'provider-a:rollback-fora-ordem-001';"
```
**Esperado:** `status = PENDING_REFERENCE`, `attempts = 0`, `next_attempt_at` ~1 minuto no futuro.

### TM-40 — A `BET` referenciada finalmente chega
```
POST {{BASE_URL}}/wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:bet-fora-ordem-001

{
  "providerId": "provider-a",
  "externalTransactionId": "bet-fora-ordem-001",
  "playerId": "player-principal",
  "walletId": "<WALLET_ID_W1>",
  "roundId": "round-fora-ordem-1",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "30.00", "currency": "BRL" }
}
```
**Esperado:** `201`, `status: "PROCESSED"`, `balance.amount: "20.00"` (50.00 - 30.00).

### TM-41 — Aguarde o worker resolver o rollback pendente (sem nenhuma nova chamada)
Espere **~65 segundos** (1 minuto do `next_attempt_at` inicial + 1 ciclo do
`PENDING_REFERENCE_REPROCESSOR_POLL_INTERVAL_MS`, default 5s). Depois:
```
GET {{BASE_URL}}/wagering/transactions/<TRANSACTION_ID_ROLLBACK_FORA_ORDEM>
```
**Esperado:** `200 OK`, `status: "PROCESSED"`, `referenceTransactionId` apontando para o id da
`bet-fora-ordem-001` acima.

### TM-42 — Confirme o saldo final de W1
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>
```
**Esperado:** `balance.amount: "50.00"` (20.00 + 30.00 do `ROLLBACK` de `bet-fora-ordem-001`, que
aplicou o efeito inverso de uma `BET` — crédito).
📌 Saldo final de W1: **50.00 BRL**. Fim da Fase 8.

---

## FASE 9 — Consultas de transação

### TM-43 — Consultar pelo id interno
```
GET {{BASE_URL}}/wagering/transactions/<TRANSACTION_ID_BET_001>
```
**Esperado:** `200`, `status: "PROCESSED"`, `kind: "BET"`, `money.amount: "100.00"`.

### TM-44 — Consultar pela chave de negócio do provedor
```
GET {{BASE_URL}}/providers/provider-a/wagering/transactions/bet-001
```
**Esperado:** mesmo body do TM-43.

---

## FASE 10 — Ledger paginado

### TM-45 — Primeira página (limit=3)
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>/ledger?limit=3
```
**Esperado:** `200`, `entries` com 3 itens (ordenados por `createdAt` ascendente — o primeiro é o
`OPENING` da criação da wallet), `nextCursor` preenchido.
📌 **Anote `<CURSOR_PAGINA_1>`** (valor de `nextCursor`).

### TM-46 — Segunda página
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>/ledger?cursor=<CURSOR_PAGINA_1>&limit=3
```
**Esperado:** `200`, próximos 3 lançamentos (sem repetir nem pular nenhum da página anterior).

### TM-47 — `limit` inválido (não numérico)
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>/ledger?limit=abc
```
**Esperado:** `400 Bad Request`.

### TM-48 — `limit` inválido (zero)
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W1>/ledger?limit=0
```
**Esperado:** `400 Bad Request`.

---

## FASE 11 — Reconciliação

### TM-49 — Reconciliação consistente
```
POST {{BASE_URL}}/wallets/<WALLET_ID_W1>/reconciliation
```
**Esperado:** `200 OK`, `consistent: true`, `storedBalance.amount: "50.00"`,
`calculatedBalance.amount: "50.00"`, `difference.amount: "0.00"`.

### TM-50 — Forçar divergência artificial no banco
```
docker compose exec postgres psql -U wagering -d wagering_dev -c "update wallets set balance_amount = balance_amount + 1 where id = '<WALLET_ID_W1>';"
```
**Esperado:** `UPDATE 1`.

### TM-51 — Reconciliação divergente
```
POST {{BASE_URL}}/wallets/<WALLET_ID_W1>/reconciliation
```
**Esperado:** `200 OK` (nunca corrige automaticamente), `consistent: false`,
`storedBalance.amount: "51.00"`, `calculatedBalance.amount: "50.00"`, `difference.amount: "1.00"`.
Confira também no log da aplicação (`docker compose logs app-1` — ou a réplica que atendeu, veja
header `X-Upstream-Addr` na resposta) uma linha de nível `error` sobre a divergência.

### TM-52 — Reverter a divergência artificial
```
docker compose exec postgres psql -U wagering -d wagering_dev -c "update wallets set balance_amount = balance_amount - 1 where id = '<WALLET_ID_W1>';"
```

### TM-53 — Reconciliação volta a ficar consistente
```
POST {{BASE_URL}}/wallets/<WALLET_ID_W1>/reconciliation
```
**Esperado:** `consistent: true` novamente, `difference.amount: "0.00"`.

---

## FASE 12 — Mensageria (SQS via CMD)

Usa a **Carteira Zerada (W2)**, que está com saldo `200.00 BRL` desde o TM-14.

### TM-54 — Obter a URL da fila principal
No CMD (uma vez por sessão — reaproveite nos próximos comandos desta fase):
```
for /f "delims=" %i in ('aws --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text') do set QUEUE_URL=%i
echo %QUEUE_URL%
```
**Esperado:** uma URL impressa, algo como `http://localhost:4566/000000000000/wager-transactions.fifo`.

### TM-55 — Editar o payload da mensagem com o `walletId` real de W2
Abra `test\manual\sqs-payloads\sqs-bet-001.json` num editor de texto (ex.: `notepad`), substitua
`__WALLET_ID_W2__` pelo valor real de `<WALLET_ID_W2>` e salve.

### TM-56 — Enviar a `BET` via fila (segunda porta de entrada, mesmo efeito do HTTP)
```
aws --endpoint-url=http://localhost:4566 sqs send-message --queue-url "%QUEUE_URL%" --message-group-id "<WALLET_ID_W2>" --message-deduplication-id "msg-sqs-001" --message-body file://test/manual/sqs-payloads/sqs-bet-001.json
```
**Esperado:** resposta com `MessageId`/`MD5OfMessageBody`. Aguarde ~2 segundos (ciclo de polling do
consumer, `SQS_CONSUMER_WAIT_TIME_SECONDS`) e confira no Postman:
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W2>
```
**Esperado:** `balance.amount: "185.00"` (200.00 - 15.00).

### TM-57 — Reenviar a MESMA mensagem de negócio (redelivery simulada)
Mesmo corpo (mesmo `messageId` **dentro do JSON**), mas um `MessageDeduplicationId` diferente no
comando (simula uma redelivery real do SQS, que o `messageId` de negócio — não o nativo do SQS —
é quem garante a deduplicação):
```
aws --endpoint-url=http://localhost:4566 sqs send-message --queue-url "%QUEUE_URL%" --message-group-id "<WALLET_ID_W2>" --message-deduplication-id "msg-sqs-001-retry" --message-body file://test/manual/sqs-payloads/sqs-bet-001.json
```
Aguarde ~2s e confira de novo:
```
GET {{BASE_URL}}/wallets/<WALLET_ID_W2>
```
**Esperado:** `balance.amount: "185.00"` — **inalterado** (idempotência via `inbox_messages`).

### TM-58 — Confirmar a métrica de duplicata via canal SQS
```
GET {{BASE_URL}}/metrics
```
**Esperado:** contém a linha `idempotency_duplicates_total{channel="inbox_sqs"} 1`.

---

## FASE 13 — DLQ (⚠️ cenário disruptivo — opcional, confirme antes de executar)

> Este bloco para o Postgres temporariamente, afetando as 3 réplicas da aplicação. Só execute se
> quiser validar o comportamento de Dead Letter Queue. Pule para a Fase 14 se preferir não
> interromper o ambiente.

### TM-59 — Parar o Postgres (simula falha permanente de infraestrutura)
```
docker compose stop postgres
```

### TM-60 — Enviar uma nova mensagem (vai falhar repetidamente — Postgres fora do ar)
Edite `test\manual\sqs-payloads\sqs-dlq-demo-001.json` (substitua `__WALLET_ID_W2__` por
`<WALLET_ID_W2>` — precisa ser um id **real** de wallet já criada, senão a mensagem é descartada
na validação do envelope antes de chegar a tentar o Postgres), depois:
```
aws --endpoint-url=http://localhost:4566 sqs send-message --queue-url "%QUEUE_URL%" --message-group-id "dlq-demo" --message-deduplication-id "msg-dlq-demo-001" --message-body file://test/manual/sqs-payloads/sqs-dlq-demo-001.json
```

### TM-61 — Aguardar e confirmar a mensagem na DLQ
`maxReceiveCount=5` × `VisibilityTimeout=30s` ≈ 150s até a entrega na DLQ (o SQS só move de forma
lazy, na tentativa de receive **seguinte** a esgotar o contador — espere pelo menos 180–220s):
```
for /f "delims=" %i in ('aws --endpoint-url=http://localhost:4566 sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text') do set DLQ_URL=%i
aws --endpoint-url=http://localhost:4566 sqs receive-message --queue-url "%DLQ_URL%" --attribute-names All
```
Repita o `receive-message` a cada ~20s até a mensagem aparecer.
**Esperado:** a mensagem (`msg-dlq-demo-001` como `MessageDeduplicationId`) aparece no resultado.

### TM-62 — Confirmar o log do monitor de DLQ
```
docker compose logs app-1 | findstr "wager-transactions-dlq"
```
(repita para `app-2`/`app-3` se não achar) — **Esperado:** uma linha
`[DlqMonitorScheduler] 1 mensagem(ns) detectada(s) em wager-transactions-dlq.fifo - requer auditoria manual`.

### TM-63 — Reiniciar o Postgres (só depois de confirmar o TM-61!)
```
docker compose start postgres
```
Aguarde `docker compose ps postgres` voltar a `healthy` antes de seguir para a próxima fase.

---

## FASE 14 — Multi-instância / nginx round-robin

### TM-64 — Confirmar round-robin entre as 3 réplicas
Dispare a mesma chamada 6 vezes seguidas no Postman (ou repita manualmente), olhando o header de
resposta a cada vez:
```
GET {{BASE_URL}}/health/ready
```
**Esperado:** o header `X-Upstream-Addr` varia entre as réplicas ao longo das 6 chamadas (nem
sempre estritamente round-robin perfeito por causa de keep-alive, mas deve aparecer mais de um
valor diferente). No Postman, veja a aba "Headers" da resposta.

### TM-65 — Tirar uma réplica do ar e confirmar que o load balancer segue respondendo
```
docker compose stop app-2
```
Repita TM-64 mais algumas vezes — **esperado:** `X-Upstream-Addr` nunca mostra `app-2`, mas as
chamadas continuam respondendo `200` normalmente (nginx tenta a próxima réplica da lista).
```
docker compose start app-2
```
Aguarde ficar `healthy` de novo antes de seguir.

---

## FASE 15 — Encerramento gracioso (SIGTERM) do consumer SQS

### TM-66 — Enviar SIGTERM a uma réplica e observar o log
```
docker compose stop app-3
```
(`docker compose stop` envia `SIGTERM` e espera o grace period antes de `SIGKILL` — o
`app.enableShutdownHooks()` do Nest intercepta isso.)
```
docker compose logs app-3 | findstr "parando de receber"
```
**Esperado:** a linha `[WagerTransactionSqsConsumer] parando de receber novas mensagens de
wager-transactions.fifo` aparece nos logs **antes** do container parar — confirmando que o
consumer para de buscar mensagens novas mas conclui a que estiver em andamento.
```
docker compose start app-3
```
Aguarde ficar `healthy` de novo.

---

## FASE 16 — Métricas finais

### TM-67 — Conferir os contadores acumulados
```
GET {{BASE_URL}}/metrics
```
**Esperado (comparando com o TM-03):**
- `wager_transactions_total{status="PROCESSED",kind="BET"}`, `{status="REJECTED",...}` etc. —
  incrementados conforme as fases 4–8 (vários `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` processados e
  rejeitados).
- `idempotency_duplicates_total{channel="http"} 1` (do TM-20) e
  `idempotency_duplicates_total{channel="inbox_sqs"} 1` (do TM-57).
- `dlq_messages_total` incrementado em `1`, se você executou a Fase 13.
- `lock_wait_timeout_total` — deve seguir `0` (nenhum cenário deste roteiro força timeout de lock).
- `outbox_lag_seconds` presente (Gauge — valor varia conforme o momento da leitura).

---

## Limpeza (opcional)

Para desligar tudo ao final da bateria de testes:
```
docker compose down
```
Adicione `-v` (`docker compose down -v`) **somente** se quiser também apagar o volume do Postgres
(perde todos os dados criados neste roteiro) — não é necessário para rodar o roteiro de novo (ele
cria wallets/transações novas a cada execução, graças aos `externalTransactionId`/`Idempotency-Key`
usados aqui; rodar duas vezes sem recriar o banco geraria conflitos de idempotência/wallet
duplicada nos testes de criação).

---

## Collection Postman (import opcional)

Se preferir não copiar/colar cada request manualmente, importe os dois arquivos abaixo direto no
Postman (`File > Import`):

- `postman/collections/wagering-manual-tests.postman_collection.json` — todos os requests deste
  roteiro, já na ordem das fases, agrupados em pastas. Cada request de criação (wallet, transação)
  tem um script que captura automaticamente o `id` retornado em uma variável de coleção
  (`walletIdW1`, `walletIdW2`, `transactionIdBet001` etc.) — os requests seguintes já usam essas
  variáveis, sem você precisar copiar/colar ids manualmente.
- `postman/environments/wagering-local.postman_environment.json` — define `BASE_URL` como
  `http://localhost` (ajuste se mudou `NGINX_PORT`).

Depois de importar, selecione o Environment "Wagering - Local" no canto superior direito do
Postman antes de rodar qualquer request. A Fase 12/13 (SQS via CMD) continua fora da collection —
ela não tem como executar comandos `aws cli` — mas os requests HTTP de "antes"/"depois" de cada
envio de mensagem (ex.: TM-56 confere o saldo de W2) estão lá, nas pastas "Fase 2" e "Fase 12".
