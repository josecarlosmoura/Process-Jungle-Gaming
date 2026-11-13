# Distributed Wagering Processor

Serviço financeiro distribuído que recebe transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de provedores de jogos via HTTP e SQS, e debita/credita carteiras (`Wallet`) de jogadores com garantias fortes de concorrência, idempotência e auditabilidade.

## Stack

- **Runtime / test runner:** [Bun](https://bun.sh)
- **Linguagem:** TypeScript (modo estrito)
- **Framework HTTP:** NestJS (adaptador Express)
- **Banco de dados:** PostgreSQL
- **Mensageria:** SQS via [LocalStack](https://www.localstack.cloud/) (ambiente local)
- **Orquestração local:** Docker Compose
- **Lint/format:** Biome

## Status atual

| Item                                                    | Status       |
| ------------------------------------------------------- | ------------ |
| Scaffold do projeto (Bun + NestJS + TypeScript estrito) | ✅ concluído |
| Docker Compose base (PostgreSQL + LocalStack)           | ✅ concluído |
| ConfigModule + variáveis de ambiente + `/health/live`   | ✅ concluído |
| MikroORM + migrations + `/health/ready` (Postgres)      | ✅ concluído |
| Cliente SQS + filas + `/health/ready` (SQS)             | ✅ concluído |
| `Money` (value object de domínio)                       | ✅ concluído |
| Tabela `wallets` (migration + constraints no banco)     | ✅ concluído |
| Entidade de domínio `Wallet` (Aggregate Root, sem ORM)  | ✅ concluído |
| Tabela `wager_transactions` (migration + constraints no banco) | ✅ concluído |
| Entidade de domínio `WagerTransaction` (máquina de estados, sem ORM) | ✅ concluído |
| Tabela `wallet_ledger_entries` (migration + constraints no banco) | ✅ concluído |
| Entidade de domínio `WalletLedgerEntry` (estruturalmente imutável, sem ORM) | ✅ concluído |
| Repositórios (`Wallet`/`WagerTransaction`/`WalletLedgerEntry`) com MikroORM, incluindo lock pessimista por `walletId` | ✅ concluído |
| `CreateWalletUseCase`/`GetWalletUseCase` + `POST /wallets` + `GET /wallets/:walletId` | ✅ concluído |

A aplicação valida as variáveis de ambiente no boot (fail-fast: uma variável ausente ou malformada derruba o processo antes de ele escutar), conecta ao PostgreSQL via MikroORM, mantém um cliente SQS apontando para o LocalStack e expõe `GET /health/live` e `GET /health/ready` — nenhum endpoint de negócio existe ainda, isso começa nas próximas tarefas. O domínio já tem quatro blocos de construção — `Money` (`src/domain/money.ts`), `Wallet` (`src/domain/wallet.ts`, Aggregate Root com `open`/`rehydrate`/`debit`/`credit`), `WagerTransaction` (`src/domain/wager-transaction.ts`, com a máquina de estados `PENDING`/`PENDING_REFERENCE`/`PROCESSED`/`REJECTED`/`FAILED`, `create`/`createOpening`/`rehydrate` e as consultas `affectsBalance`/`requiresReference`/`matchesPayload`/`ledgerDirectionFor`) e `WalletLedgerEntry` (`src/domain/wallet-ledger-entry.ts`, estruturalmente imutável — sem nenhum método de transição — cuja factory `create` valida a própria aritmética do lançamento, `balanceBefore ± money == balanceAfter` conforme a `direction`, e `rehydrate` reconstrói sem revalidar) —, mas nenhum dos quatro ainda é consumido por nenhuma rota ou fila — são classes de domínio puras (sem ORM, sem banco), exercidas apenas pela própria suíte de testes unitários. As tabelas `wallets`, `wager_transactions` e `wallet_ledger_entries` já existem no banco, com as garantias de unicidade, integridade referencial e formato aplicadas diretamente pelo Postgres (`UNIQUE`/`CHECK`/FK) — `wager_transactions` inclui a constraint de idempotência (`UNIQUE (idempotency_key)`), a unicidade de referência externa (`UNIQUE (provider_id, external_transaction_id)`), FKs para `wallets` e para si mesma (`ON DELETE RESTRICT`) e `CHECK`s fechados de `kind`/`status`; `wallet_ledger_entries` é o histórico contábil append-only (um lançamento por transação por wallet, via `UNIQUE (wallet_id, transaction_id)`), com FKs para `wallets` e `wager_transactions` (`ON DELETE RESTRICT`), `CHECK` fechado de `direction` (`DEBIT`/`CREDIT`) e um `CHECK` que reforça no próprio banco a consistência aritmética do lançamento (`balance_before_amount ± money_amount = balance_after_amount`, conforme a direção) — nenhuma coluna de status/estado mutável existe nesta tabela, e nenhuma rotina de `UPDATE`/`DELETE` sobre ela existe em nenhuma camada do código. As três tabelas já têm entidade MikroORM mapeada e repositório concreto (`src/infrastructure/persistence/`), implementando as portas `WalletRepository`/`WagerTransactionRepository`/`WalletLedgerEntryRepository` (`src/application/ports/`) — a conversão `string ↔ Money` acontece inteira dentro do repositório, nunca no domínio. `WalletMikroOrmRepository.findByIdForUpdate` é a primeira aparição real do lock pessimista por `walletId` (`SELECT ... FOR UPDATE`, provado por um teste automatizado que serializa duas transações concorrentes sobre a mesma wallet, além do passo manual com dois `psql` descrito mais abaixo). `save()` é upsert para `Wallet`/`WagerTransaction`, mas só insere (nunca upsert) para `WalletLedgerEntry` — uma segunda gravação com o mesmo id estoura a constraint única do Postgres em vez de sobrescrever silenciosamente, reforçando a imutabilidade do ledger. A listagem paginada do ledger (`findByWalletId`) usa um cursor opaco assinado com HMAC-SHA256 (chave em `LEDGER_CURSOR_SECRET`), nunca um número de página. Esses repositórios já têm um primeiro consumidor real: `CreateWalletUseCase` (`src/application/use-cases/create-wallet.use-case.ts`) cria uma wallet dentro de uma única transação SQL (`EntityManager.transactional()`) — verifica unicidade `(playerId, currency)` (conflito vira `409`, com a constraint do banco como última linha de defesa contra corrida), cria a `Wallet` e, só quando `initialBalance` é positivo, gera internamente uma transação `OPENING` já `PROCESSED` e o `WalletLedgerEntry` `CREDIT` correspondente. Como `OPENING` não tem provedor/rodada/jogo reais por trás, as colunas `provider_id`/`external_transaction_id`/`round_id`/`game_id`/`payload_hash` de `wager_transactions` são `NULL` exatamente para esse `kind` (nunca um valor fabricado) — uma `CHECK` no próprio banco garante o inverso (`NOT NULL`) para qualquer outro `kind`. `GetWalletUseCase` consulta por `WalletRepository.findById` (leitura simples, sem o lock pessimista de `findByIdForUpdate`).

## Endpoints

| Método | Rota            | Descrição                                                                                                                                                                 | Autenticação              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GET`  | `/health/live`  | Confirma só que o processo está vivo — nunca consulta Postgres, SQS ou qualquer dependência externa. Responde `200 { "status": "ok" }` mesmo com `docker compose down`. | Nenhuma (endpoint aberto) |
| `GET`  | `/health/ready` | Confirma que a aplicação consegue executar uma query real no PostgreSQL **e** resolver a fila principal no SQS/LocalStack configurados (timeout de 2000ms cada, em paralelo). Responde `200 { "status": "ok", "postgres": "up", "sqs": "up" }` quando ambos alcançáveis, `503 { "status": "error", "postgres": "up"/"down", "sqs": "up"/"down" }` quando qualquer um falha, sempre com os dois campos presentes para indicar qual dependência está fora do ar. | Nenhuma (endpoint aberto) |
| `POST` | `/wallets` | Cria uma wallet para `{ playerId, initialBalance: { amount, currency } }`. Responde `201 { id, playerId, balance: { amount, currency }, version: 1 }`. Se `initialBalance.amount` for maior que zero, gera internamente uma transação `OPENING` `PROCESSED` + um lançamento `CREDIT` no ledger, tudo na mesma transação SQL. `409` se já existir wallet para o mesmo `(playerId, currency)`; `400` para payload inválido (`currency` fora do formato `AAA`, `amount` com mais de 2 casas decimais, `playerId` vazio). | Nenhuma (ponto de extensão documentado, não implementado) |
| `GET`  | `/wallets/:walletId` | Consulta o estado atual da wallet. Responde `200 { id, playerId, balance: { amount, currency }, version }`; `404` se o `walletId` não existir. | Nenhuma (idem) |

## Pré-requisitos

- [Bun](https://bun.sh) instalado (`bun --version`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) com Docker Compose v2 (`docker compose version`)

## Subindo o ambiente

```bash
# 1. Instalar dependências do projeto
bun install

# 2. Criar o .env local a partir do template (nunca commitar o .env real)
cp .env.example .env

# 3. Subir a infraestrutura (PostgreSQL + LocalStack/SQS); as filas sao provisionadas automaticamente
docker compose up -d

# 4. Conferir que os serviços ficaram saudáveis (pode levar alguns segundos)
docker compose ps
# Esperado: "postgres" e "localstack" com status "healthy"; "localstack-init" com status
# "Exited (0)" — ele roda uma única vez para criar as filas e sai, não é um serviço de longa duração

# 4b. Opcional: confirmar que as filas existem
aws --endpoint-url=http://localhost:4566 sqs list-queues
# Esperado: lista wager-transactions.fifo e wager-transactions-dlq.fifo

# 5. Aplicar as migrations contra o Postgres do Compose
bun run migration:up

# 6. Subir a aplicação NestJS em modo desenvolvimento (hot reload)
bun run start:dev
```

Outros comandos úteis:

```bash
bun run build            # compila para dist/
bun run start            # roda o build compilado (dist/main.js)
bun run lint              # Biome lint
bun run format:check       # Biome format (checagem, sem escrever)
bun test                  # suíte de testes (Bun test runner)
bun run test:unit          # testes que não dependem de Postgres/SQS reais
bun run test:integration    # testes que exigem Postgres/SQS reais (Compose precisa estar no ar)

bun run migration:create -- --blank --name Nome   # cria uma nova migration (vazia, para editar à mão)
bun run migration:up        # aplica as migrations pendentes contra o Postgres do Compose
bun run migration:down      # reverte a última migration aplicada

docker compose down        # derruba os serviços (mantém os dados, pois o volume do Postgres é nomeado)
docker compose logs -f postgres   # acompanhar logs do Postgres em tempo real
```

## Variáveis de ambiente

Documentadas em `.env.example` (copie para `.env` antes de subir o ambiente — veja o passo 2 acima). Nenhum valor nesse arquivo é um segredo real: são credenciais fixas de desenvolvimento local.

| Variável                                                                          | Para quê serve                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PORT`                                                                            | Porta HTTP em que a aplicação NestJS escuta (default `3000`)                      |
| `NODE_ENV`                                                                        | Ambiente de execução (`development`\|`test`\|`production`, default `development`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`                         | Conexão com o PostgreSQL do Docker Compose                                        |
| `LOCALSTACK_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Conexão com o LocalStack (SQS) — as credenciais AWS são dummy, só para uso local  |
| `LEDGER_CURSOR_SECRET`                                                           | Chave simétrica usada para assinar (HMAC-SHA256) o cursor opaco de paginação do ledger — nunca um valor real de produção em `.env.example`/`.env` local |

Todas são validadas no boot (`src/infrastructure/config/env.schema.ts`, via `zod`) de forma tipada — uma variável ausente, de tipo errado ou malformada (ex.: `LOCALSTACK_ENDPOINT` sem `http://`) derruba o processo imediatamente, com uma mensagem citando a variável, antes de qualquer rota aceitar tráfego. Variáveis extras do sistema operacional são ignoradas sem quebrar a validação.

**Troubleshooting — `FATAL: password authentication failed` ao conectar com um cliente externo (DBeaver, pgAdmin etc.):** se a sua máquina já tem um PostgreSQL nativo instalado (comum em Windows, via instalador oficial), pode haver um conflito: esse Postgres nativo costuma escutar em `5432` via IPv6 (`[::]:5432`), enquanto o Docker publica em IPv4 (`0.0.0.0:5432`); como `localhost` pode resolver para IPv6 primeiro, o cliente acaba conectando no Postgres nativo errado em vez do container. Duas saídas, sem precisar desligar nada:

- No cliente, use o host `127.0.0.1` em vez de `localhost` (força IPv4); ou
- Troque `DB_PORT` no seu `.env` **local** (nunca no `.env.example`) para uma porta livre (ex.: `5440`) e suba o Compose de novo.

## Estrutura de pastas

```
scripts/
└── setup-queues.sh    # provisiona as filas SQS no LocalStack (idempotente)

src/
├── domain/           # entidades e regras de negócio — nunca importa NestJS/ORM
│   ├── money.ts       # Money: value object imutável de quantia monetária (decimal.js, nunca number)
│   ├── wallet.ts      # Wallet: Aggregate Root (open/rehydrate/debit/credit), sem ORM
│   ├── wager-transaction.ts   # WagerTransaction: máquina de estados (create/createOpening/rehydrate), sem ORM
│   └── wallet-ledger-entry.ts  # WalletLedgerEntry: lançamento estruturalmente imutável (create/rehydrate/isBalanced), sem ORM
├── application/       # casos de uso (reutilizados por HTTP e SQS)
│   ├── ports/          # interfaces de repositório (WalletRepository/WagerTransactionRepository/WalletLedgerEntryRepository) + cursor assinado do ledger — nunca importa MikroORM/NestJS
│   └── use-cases/      # CreateWalletUseCase, GetWalletUseCase
├── infrastructure/     # MikroORM, cliente SQS, adaptadores concretos
│   ├── config/        # validação tipada de variáveis de ambiente (AppConfigModule/AppConfigService)
│   ├── database/      # conexão MikroORM (DatabaseModule), health check do Postgres, migrations/ (tabelas wallets, wager_transactions e wallet_ledger_entries)
│   ├── messaging/      # cliente SQS (SqsModule), health check do SQS, nomes das filas
│   └── persistence/    # entidades MikroORM e repositórios concretos (Wallet/WagerTransaction/WalletLedgerEntry) — a conversão string ↔ Money mora aqui
└── presentation/       # controllers HTTP / consumer SQS — adaptadores finos
    ├── health/         # GET /health/live, GET /health/ready
    └── wallets/        # POST /wallets, GET /wallets/:walletId (WalletsController + WalletsModule)
```

## Migrations

Rodam via a CLI do MikroORM (`@mikro-orm/cli`), configurada em `mikro-orm.config.ts` (raiz do projeto) e `src/infrastructure/database/mikro-orm.config.ts`. Os arquivos ficam em `src/infrastructure/database/migrations/`.

```bash
bun run migration:up               # aplica todas as migrations pendentes contra o Postgres do Compose
bun run migration:down             # reverte só a última migration aplicada (um passo)
bun run migration:down -- --to 0   # reverte todas as migrations (volta ao banco vazio)
```

Nenhuma migration roda automaticamente no boot da aplicação — são sempre comandos explícitos de operador/CI.

| Migration | Cria |
| --- | --- |
| `Migration20261112123041_Initial` | Extensão `pgcrypto` (usada por `gen_random_uuid()` em inserts manuais/testes) |
| `Migration20261112175001_CreateWallets` | Tabela `wallets`: `id`, `player_id`, `currency`, `balance_amount`, `version`, `created_at`, `updated_at`, com `UNIQUE (player_id, currency)`, `CHECK (balance_amount >= 0)` e `CHECK` de formato de moeda (3 letras maiúsculas) |
| `Migration20261112192841_CreateWagerTransactions` | Tabela `wager_transactions` (18 colunas, incluindo `kind`, `status`, `money_amount`/`money_currency`), com `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, FK `wallet_id` → `wallets.id` e FK auto-referencial `reference_transaction_id` (ambas `ON DELETE RESTRICT`), `CHECK` fechado de `kind`/`status`, `CHECK` de formato de moeda e um índice não único em `(provider_id, reference_external_transaction_id)` |
| `Migration20261112222253_CreateWalletLedgerEntries` | Tabela `wallet_ledger_entries` (9 colunas: `id`, `wallet_id`, `transaction_id`, `direction`, `money_amount`/`money_currency`, `balance_before_amount`, `balance_after_amount`, `created_at`), com `UNIQUE (wallet_id, transaction_id)`, FKs `wallet_id` → `wallets.id` e `transaction_id` → `wager_transactions.id` (ambas `ON DELETE RESTRICT`), `CHECK` fechado de `direction`, `CHECK` de formato de moeda e `CHECK` da consistência aritmética do lançamento — nenhuma coluna de status/estado mutável |
| `Migration20261113090000_WagerTransactionsOpeningFieldsNullable` | Altera `wager_transactions`: `provider_id`/`external_transaction_id`/`round_id`/`game_id`/`payload_hash` deixam de ser `NOT NULL` na coluna, e ganham a constraint `CHECK wager_transactions_opening_fields_null_check`, que exige os cinco campos `NULL` quando `kind = 'OPENING'` e `NOT NULL` em qualquer outro `kind` |

## Repositórios e lock pessimista

Os repositórios concretos vivem em `src/infrastructure/persistence/` (`wallet.repository.ts`, `wager-transaction.repository.ts`, `wallet-ledger-entry.repository.ts`), cada um implementando a porta correspondente de `src/application/ports/`. São exercidos pelos testes de integração abaixo, que rodam contra o Postgres real do Compose, e também pelo fluxo real de `POST /wallets`/`GET /wallets/:walletId` (seção "Wallets", mais abaixo):

```bash
bun run migration:up
bun test src/infrastructure/persistence/wallet.repository.integration.spec.ts
bun test src/infrastructure/persistence/wager-transaction.repository.integration.spec.ts
bun test src/infrastructure/persistence/wallet-ledger-entry.repository.integration.spec.ts
```

Um desses testes automatizados já prova, com duas transações reais concorrentes, que `findByIdForUpdate` serializa o acesso à mesma wallet (lock pessimista) sem bloquear wallets diferentes entre si. Para observar o mesmo mecanismo manualmente, com duas sessões `psql`:

```bash
# Sessão A:
docker compose exec postgres psql -U wagering -d wagering_dev
BEGIN;
SELECT * FROM wallets LIMIT 1 FOR UPDATE;
-- não faça COMMIT ainda, deixe a transação aberta.

# Sessão B (outro terminal):
docker compose exec postgres psql -U wagering -d wagering_dev
BEGIN;
SELECT * FROM wallets WHERE id = '<mesmo id da sessão A>' FOR UPDATE;
-- Esperado: esta query FICA BLOQUEADA até a sessão A fazer COMMIT/ROLLBACK.
```

## Wallets

Primeiro fluxo ponta a ponta do sistema. Com a aplicação no ar (`bun run start:dev`, porta `3000` por padrão):

```bash
# Criar uma wallet com saldo inicial positivo (gera OPENING + lançamento CREDIT, na mesma transação SQL)
curl -i -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"<uuid qualquer>","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# Esperado: 201, corpo { id, playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 }

# Consultar a wallet criada (copie o "id" da resposta anterior)
curl -i http://localhost:3000/wallets/<id>
# Esperado: 200, mesmo corpo

# Repetir o POST com o mesmo playerId/currency
curl -i -X POST http://localhost:3000/wallets -H "Content-Type: application/json" \
  -d '{"playerId":"<mesmo uuid>","initialBalance":{"amount":"500.00","currency":"BRL"}}'
# Esperado: 409, nenhuma wallet nova criada

# Consultar um id inexistente
curl -i http://localhost:3000/wallets/00000000-0000-0000-0000-000000000000
# Esperado: 404

# Conferir no banco: OPENING/PROCESSED com os campos de provedor nulos, e o lançamento CREDIT
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "SELECT kind, status, provider_id, external_transaction_id, round_id, game_id, payload_hash, money_amount FROM wager_transactions WHERE wallet_id = '<id>';"
docker compose exec postgres psql -U wagering -d wagering_dev -c \
  "SELECT direction, money_amount, balance_before_amount, balance_after_amount FROM wallet_ledger_entries WHERE wallet_id = '<id>';"
```

```bash
bun test src/presentation/wallets/wallets.e2e.spec.ts   # suíte automatizada do fluxo acima, contra o Postgres real do Compose
```

## Docker Compose

`docker-compose.yml` sobe `postgres` e `localstack` numa rede dedicada (`wagering-net`), cada um com healthcheck próprio, e um terceiro serviço, `localstack-init`, que roda uma única vez (assim que `localstack` fica saudável), provisiona as filas SQS e sai — não é um serviço de longa duração, então aparece como `Exited (0)` em `docker compose ps`, o que é esperado. A aplicação NestJS ainda **não** faz parte do Compose (isso entra mais adiante, quando houver múltiplas réplicas para testar) — hoje ela roda localmente via `bun run start:dev`, apontando para os serviços subidos pelo Compose.

## Filas SQS

Provisionadas automaticamente por `scripts/setup-queues.sh` (executado pelo serviço `localstack-init` do Compose, ou manualmente contra qualquer LocalStack já no ar):

```bash
scripts/setup-queues.sh   # roda contra http://localhost:4566 por padrão (SQS_ENDPOINT_URL sobrescreve)
```

| Fila | Papel |
| --- | --- |
| `wager-transactions.fifo` | Fila principal, FIFO — recebe as transações de aposta (consumidor chega na Fase 2) |
| `wager-transactions-dlq.fifo` | Dead-letter queue, associada à fila principal via `RedrivePolicy` |

O script é idempotente (rodar mais de uma vez não duplica nem falha) e não publica nem consome nenhuma mensagem — isso é escopo de tarefas futuras. O valor de `maxReceiveCount` da `RedrivePolicy` é um placeholder nesta etapa; seu valor final e a justificativa formal ficam para a tarefa que fecha a política de DLQ.
