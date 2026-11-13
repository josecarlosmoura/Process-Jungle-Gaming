import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

describe("GET /health/ready - postgres down", () => {
  test("boots with an unreachable Postgres and responds 503 with postgres down and sqs up over real HTTP", async () => {
    // porta TCP sem nada escutando - conexao recusada rapido, sem precisar parar o Compose
    // @nestjs/config le process.env no instante em que o modulo e importado (ver app.e2e.spec.ts);
    // como e um import dinamico, fica em cache por processo - rodar este arquivo junto com
    // health.ready.integration.spec.ts no mesmo processo (sem --isolate) vazaria este DB_PORT
    // invalido para o outro teste, por isso "bun run test:integration" usa --isolate
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "1",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_test",
      LOCALSTACK_ENDPOINT: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      // 4317: porta exclusiva deste arquivo - 4312 colidia com wallets.e2e.spec.ts (mesmo
      // numero hardcoded em dois arquivos diferentes), causando EADDRINUSE quando os dois
      // corriam juntos (suite completa, ou qualquer selecao da IDE que inclua ambos).
      PORT: "4317",
    });

    const { AppModule } = await import("../../app.module");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(4317);

    const response = await fetch("http://127.0.0.1:4317/health/ready");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "error", postgres: "down", sqs: "up" });

    await app.close();
  });
});
