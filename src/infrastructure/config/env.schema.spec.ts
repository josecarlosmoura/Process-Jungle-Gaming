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

  test("defaults OUTBOX_PUBLISHER_POLL_INTERVAL_MS to 2000 and OUTBOX_PUBLISHER_BATCH_SIZE to 20, and accepts an override for each", () => {
    const defaults = validateEnv(validEnv);
    expect(defaults.OUTBOX_PUBLISHER_POLL_INTERVAL_MS).toBe(2000);
    expect(defaults.OUTBOX_PUBLISHER_BATCH_SIZE).toBe(20);

    const overridden = validateEnv({
      ...validEnv,
      OUTBOX_PUBLISHER_POLL_INTERVAL_MS: "500",
      OUTBOX_PUBLISHER_BATCH_SIZE: "5",
    });
    expect(overridden.OUTBOX_PUBLISHER_POLL_INTERVAL_MS).toBe(500);
    expect(overridden.OUTBOX_PUBLISHER_BATCH_SIZE).toBe(5);
  });

  test("defaults SQS_CONSUMER_WAIT_TIME_SECONDS to 10, and accepts an override within 0-20", () => {
    const defaults = validateEnv(validEnv);
    expect(defaults.SQS_CONSUMER_WAIT_TIME_SECONDS).toBe(10);

    const overridden = validateEnv({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: "5" });
    expect(overridden.SQS_CONSUMER_WAIT_TIME_SECONDS).toBe(5);

    // Limites exatos aceitos: 0 (sem long polling) e 20 (maximo do proprio SQS).
    expect(
      validateEnv({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: "0" })
        .SQS_CONSUMER_WAIT_TIME_SECONDS,
    ).toBe(0);
    expect(
      validateEnv({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: "20" })
        .SQS_CONSUMER_WAIT_TIME_SECONDS,
    ).toBe(20);

    expect(() => validateEnv({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: "-1" })).toThrow(
      "SQS_CONSUMER_WAIT_TIME_SECONDS",
    );
    expect(() => validateEnv({ ...validEnv, SQS_CONSUMER_WAIT_TIME_SECONDS: "21" })).toThrow(
      "SQS_CONSUMER_WAIT_TIME_SECONDS",
    );
  });

  test("defaults DLQ_MONITOR_POLL_INTERVAL_MS to 5000, and accepts an override", () => {
    const defaults = validateEnv(validEnv);
    expect(defaults.DLQ_MONITOR_POLL_INTERVAL_MS).toBe(5000);

    const overridden = validateEnv({ ...validEnv, DLQ_MONITOR_POLL_INTERVAL_MS: "1000" });
    expect(overridden.DLQ_MONITOR_POLL_INTERVAL_MS).toBe(1000);
  });
});
