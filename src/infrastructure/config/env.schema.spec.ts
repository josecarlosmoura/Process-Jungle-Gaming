import { describe, expect, test } from "bun:test";
import { validateEnv } from "./env.schema";

const validEnv: Record<string, unknown> = {
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering_dev",
  LOCALSTACK_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  LEDGER_CURSOR_SECRET: "test-ledger-cursor-secret",
};

describe("validateEnv", () => {
  test("accepts a complete, valid environment", () => {
    expect(() => validateEnv(validEnv)).not.toThrow();
  });

  test("rejects a missing or malformed required variable, naming it in the error", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validEnv, DB_HOST: undefined }, "DB_HOST"],
      [{ ...validEnv, DB_PORT: "abc" }, "DB_PORT"],
      [{ ...validEnv, AWS_REGION: "" }, "AWS_REGION"],
      [{ ...validEnv, LOCALSTACK_ENDPOINT: "localhost:4566" }, "LOCALSTACK_ENDPOINT"],
      [{ ...validEnv, LEDGER_CURSOR_SECRET: undefined }, "LEDGER_CURSOR_SECRET"],
      [{ ...validEnv, LEDGER_CURSOR_SECRET: "" }, "LEDGER_CURSOR_SECRET"],
    ];

    for (const [env, expectedField] of cases) {
      expect(() => validateEnv(env)).toThrow(expectedField);
    }
  });

  test("ignores environment keys the schema does not declare", () => {
    const env = { ...validEnv, PATH: "/usr/bin", SOME_RANDOM_OS_VAR: "whatever" };
    expect(() => validateEnv(env)).not.toThrow();
  });
});
