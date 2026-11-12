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
| Cliente SQS + filas + `/health/ready` (SQS)             | ⏳ próximo   |
| Domínio (`Wallet`, `WagerTransaction`, `Money`, Ledger) | pendente     |

A aplicação valida as variáveis de ambiente no boot (fail-fast: uma variável ausente ou malformada derruba o processo antes de ele escutar), conecta ao PostgreSQL via MikroORM e expõe `GET /health/live` e `GET /health/ready` — nenhum endpoint de negócio existe ainda, isso começa nas próximas tarefas.

## Endpoints

| Método | Rota            | Descrição                                                                                                                                                                 | Autenticação              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GET`  | `/health/live`  | Confirma só que o processo está vivo — nunca consulta Postgres, SQS ou qualquer dependência externa. Responde `200 { "status": "ok" }` mesmo com `docker compose down`. | Nenhuma (endpoint aberto) |
| `GET`  | `/health/ready` | Confirma que a aplicação consegue executar uma query real no PostgreSQL configurado (timeout de 2000ms). Responde `200 { "status": "ok", "postgres": "up" }` quando alcançável, `503 { "status": "error", "postgres": "down" }` quando não (ainda não considera SQS — isso é a próxima tarefa). | Nenhuma (endpoint aberto) |

## Pré-requisitos

- [Bun](https://bun.sh) instalado (`bun --version`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) com Docker Compose v2 (`docker compose version`)

## Subindo o ambiente

```bash
# 1. Instalar dependências do projeto
bun install

# 2. Criar o .env local a partir do template (nunca commitar o .env real)
cp .env.example .env

# 3. Subir a infraestrutura (PostgreSQL + LocalStack/SQS)
docker compose up -d

# 4. Conferir que os dois serviços ficaram saudáveis (pode levar alguns segundos)
docker compose ps
# Esperado: "postgres" e "localstack" com status "healthy"

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
src/
├── domain/           # entidades e regras de negócio — nunca importa NestJS/ORM
├── application/       # casos de uso (reutilizados por HTTP e SQS)
├── infrastructure/     # MikroORM, publisher SQS, adaptadores concretos
│   ├── config/        # validação tipada de variáveis de ambiente (AppConfigModule/AppConfigService)
│   └── database/      # conexão MikroORM (DatabaseModule), health check do Postgres, migrations/
└── presentation/       # controllers HTTP / consumer SQS — adaptadores finos
    └── health/         # GET /health/live, GET /health/ready
```

## Migrations

Rodam via a CLI do MikroORM (`@mikro-orm/cli`), configurada em `mikro-orm.config.ts` (raiz do projeto) e `src/infrastructure/database/mikro-orm.config.ts`. Os arquivos ficam em `src/infrastructure/database/migrations/`.

```bash
bun run migration:up      # aplica as migrations pendentes contra o Postgres do Compose
bun run migration:down    # reverte a última migration aplicada
```

Nenhuma migration roda automaticamente no boot da aplicação — são sempre comandos explícitos de operador/CI.

## Docker Compose

`docker-compose.yml` sobe `postgres` e `localstack` numa rede dedicada (`wagering-net`), cada um com healthcheck próprio. A aplicação NestJS ainda **não** faz parte do Compose (isso entra mais adiante, quando houver múltiplas réplicas para testar) — hoje ela roda localmente via `bun run start:dev`, apontando para os serviços subidos pelo Compose.
