import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

describe("AppModule boot", () => {
  test("listens on the exact port AppConfigService provides, not a hardcoded one", async () => {
    // @nestjs/config le process.env no instante em que o modulo e importado (decoracao de
    // classe, antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do
    // import dinamico de AppModule, nunca depois de um import estatico no topo do arquivo.
    Object.assign(process.env, {
      DB_HOST: "localhost",
      DB_PORT: "5440",
      DB_USER: "wagering",
      DB_PASSWORD: "wagering",
      DB_NAME: "wagering_dev",
      LOCALSTACK_ENDPOINT: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      PORT: "4310",
    });

    const { AppModule } = await import("./app.module");
    const { AppConfigService } = await import("./infrastructure/config/app-config.service");

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    const config = app.get(AppConfigService);
    await app.init();
    await app.listen(config.port);

    const address = app.getHttpServer().address();
    const boundPort = typeof address === "object" && address !== null ? address.port : 0;

    expect(config.port).toBe(4310);
    expect(boundPort).toBe(4310);

    const response = await fetch(`http://127.0.0.1:${boundPort}/health/live`);
    expect(response.status).toBe(200);

    await app.close();
  });
});
