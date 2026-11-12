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
});
