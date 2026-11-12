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
| Entidade de domínio `Wallet` (MikroORM)                 | ⏳ próximo   |

A aplicação valida as variáveis de ambiente no boot (fail-fast: uma variável ausente ou malformada derruba o processo antes de ele escutar), conecta ao PostgreSQL via MikroORM, mantém um cliente SQS apontando para o LocalStack e expõe `GET /health/live` e `GET /health/ready` — nenhum endpoint de negócio existe ainda, isso começa nas próximas tarefas. O domínio já tem seu primeiro bloco de construção, `Money` (`src/domain/money.ts`), mas ele ainda não é consumido por nenhuma rota ou fila — é um value object em memória, exercido apenas pela sua própria suíte de testes. A tabela `wallets` já existe no banco, com as garantias de unicidade (`player_id` + `currency`), saldo nunca negativo e formato de moeda aplicadas diretamente pelo Postgres (`UNIQUE`/`CHECK`) — mas ainda não há nenhuma entidade MikroORM nem rota que a leia ou escreva; ela só é exercida hoje pelo teste de integração da própria migration.

## Endpoints

| Método | Rota            | Descrição                                                                                                                                                                 | Autenticação              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GET`  | `/health/live`  | Confirma só que o processo está vivo — nunca consulta Postgres, SQS ou qualquer dependência externa. Responde `200 { "status": "ok" }` mesmo com `docker compose down`. | Nenhuma (endpoint aberto) |
| `GET`  | `/health/ready` | Confirma que a aplicação consegue executar uma query real no PostgreSQL **e** resolver a fila principal no SQS/LocalStack configurados (timeout de 2000ms cada, em paralelo). Responde `200 { "status": "ok", "postgres": "up", "sqs": "up" }` quando ambos alcançáveis, `503 { "status": "error", "postgres": "up"/"down", "sqs": "up"/"down" }` quando qualquer um falha, sempre com os dois campos presentes para indicar qual dependência está fora do ar. | Nenhuma (endpoint aberto) |

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
│   └── money.ts       # Money: value object imutável de quantia monetária (decimal.js, nunca number)
├── application/       # casos de uso (reutilizados por HTTP e SQS)
├── infrastructure/     # MikroORM, cliente SQS, adaptadores concretos
│   ├── config/        # validação tipada de variáveis de ambiente (AppConfigModule/AppConfigService)
│   ├── database/      # conexão MikroORM (DatabaseModule), health check do Postgres, migrations/ (inclui a tabela wallets)
│   └── messaging/      # cliente SQS (SqsModule), health check do SQS, nomes das filas
└── presentation/       # controllers HTTP / consumer SQS — adaptadores finos
    └── health/         # GET /health/live, GET /health/ready
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
