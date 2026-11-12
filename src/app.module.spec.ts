import { describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module";

const validEnv = {
  DB_HOST: "localhost",
  DB_PORT: "5440",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering_dev",
  LOCALSTACK_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
};

describe("AppModule", () => {
  test("boots with a complete, valid environment", async () => {
    const original = { ...process.env };
    Object.assign(process.env, validEnv);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
    process.env = original;
  });
});
