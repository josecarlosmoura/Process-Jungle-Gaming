import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

describe("GET /health/ready - postgres and sqs down", () => {
  test("boots with both Postgres and SQS unreachable and responds 503 with postgres down and sqs down over real HTTP", async () => {
    // duas portas TCP sem nada escutando - conexao recusada rapido para as duas dependencias,
    // sem precisar parar o Compose (mesmo padrao dos outros testes de "down" desta tarefa)
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "1",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_test",
      LOCALSTACK_ENDPOINT: "http://localhost:1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      PORT: "4315",
    });

    const { AppModule } = await import("../../app.module");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(4315);

    const response = await fetch("http://127.0.0.1:4315/health/ready");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "error", postgres: "down", sqs: "down" });

    await app.close();
  });
});
