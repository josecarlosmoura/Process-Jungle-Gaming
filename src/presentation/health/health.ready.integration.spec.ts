import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

describe("GET /health/ready", () => {
  test("boots against Compose Postgres and LocalStack and responds 200 with postgres up and sqs up over real HTTP", async () => {
    // @nestjs/config le process.env no instante em que o modulo e importado - por isso o env
    // precisa ser setado antes do import dinamico de AppModule (ver app.e2e.spec.ts)
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "5440",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_test",
      LOCALSTACK_ENDPOINT: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      PORT: "4311",
    });

    const { AppModule } = await import("../../app.module");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(4311);

    const response = await fetch("http://127.0.0.1:4311/health/ready");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", postgres: "up", sqs: "up" });

    await app.close();
  });
});
