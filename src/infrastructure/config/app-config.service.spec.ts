import { describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { AppConfigModule } from "./app-config.module";
import { AppConfigService } from "./app-config.service";

describe("AppConfigService", () => {
  test("exposes DB_PORT as a number, not a string", async () => {
    const original = { ...process.env };
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
      LEDGER_CURSOR_SECRET: "test-ledger-cursor-secret",
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule],
    }).compile();

    const service = moduleRef.get(AppConfigService);

    expect(service.dbPort).toBe(5440);
    expect(typeof service.dbPort).toBe("number");

    await moduleRef.close();
    process.env = original;
  });

  test("exposes ledgerCursorSecret as the configured string", async () => {
    // ConfigModule.forRoot() roda no momento em que o decorator @Module de AppConfigModule e
    // avaliado (import do arquivo, antes do corpo deste teste) - um Object.assign(process.env, ...)
    // feito aqui dentro chega tarde demais para influenciar o valor ja validado/cacheado. Por isso
    // este teste le o valor real que o .env do projeto ja definiu, em vez de tentar sobrescreve-lo.
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule],
    }).compile();

    const service = moduleRef.get(AppConfigService);

    expect(service.ledgerCursorSecret).toBe(process.env.LEDGER_CURSOR_SECRET);
    expect(service.ledgerCursorSecret.length).toBeGreaterThan(0);

    await moduleRef.close();
  });
});
