import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

describe("GET /health/ready - sqs down", () => {
  test("boots with an unreachable SQS endpoint and responds 503 with sqs down and postgres up over real HTTP", async () => {
    // porta TCP sem nada escutando - conexao recusada rapido, sem precisar parar o LocalStack
    // (mesmo padrao de health.ready.down.integration.spec.ts para o Postgres)
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "5440",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_test",
      LOCALSTACK_ENDPOINT: "http://localhost:1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      PORT: "4313",
    });

    const { AppModule } = await import("../../app.module");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(4313);

    const response = await fetch("http://127.0.0.1:4313/health/ready");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "error", postgres: "up", sqs: "down" });

    await app.close();
  });

  test("health live still responds 200 while the SQS endpoint is unreachable", async () => {
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "5440",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_test",
      LOCALSTACK_ENDPOINT: "http://localhost:1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      PORT: "4314",
    });

    const { AppModule } = await import("../../app.module");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(4314);

    const response = await fetch("http://127.0.0.1:4314/health/live");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });

    await app.close();
  });
});
