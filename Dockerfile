# Estagio "build": tudo que o codigo-fonte TypeScript e a CLI do MikroORM precisam (devDependencies
# incluidas) - usado tanto para compilar quanto, via "docker compose ... build --target build", pelo
# servico "migrate" (roda "bun run migration:up" sob ts-node/@mikro-orm/cli, nenhum dos dois presente
# no estagio final "runtime").
FROM oven/bun:1-alpine AS build

# node e necessario porque "bun run start"/"bun run migration:up" executam scripts que chamam node
# por baixo (package.json); curl e usado pelo healthcheck do servico "app" (docker-compose.yml e
# docker-compose.test.yml), mesmo padrao do healthcheck do localstack.
RUN apk add --no-cache nodejs curl

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Estagio final "runtime": so o necessario para rodar a aplicacao compilada - sem devDependencies
# (ts-node, @mikro-orm/cli, typescript, biome) nem o codigo-fonte TypeScript, usado pelos servicos
# "app-1"/"app-2"/"app-3" (target implicito, por ser o ultimo estagio do Dockerfile).
FROM oven/bun:1-alpine AS runtime

RUN apk add --no-cache nodejs curl

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["bun", "run", "start"]
