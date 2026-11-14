FROM oven/bun:1-alpine

# node e necessario porque "bun run start" executa "node dist/main.js" (package.json) - a imagem
# base oven/bun nao traz um binario "node"; curl e usado pelo healthcheck do servico "app" em
# docker-compose.test.yml, mesmo padrao do healthcheck do localstack em docker-compose.yml.
RUN apk add --no-cache nodejs curl

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
