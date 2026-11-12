import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DEFAULT_TIMEOUT_MS, SqsHealthIndicator } from "./sqs-health.indicator";

function withSend(send: () => Promise<unknown>): SQSClient {
  return { send } as unknown as SQSClient;
}

describe("SqsHealthIndicator", () => {
  test("resolves to down when the underlying GetQueueUrl call rejects", async () => {
    const client = withSend(() => Promise.reject(new Error("connection refused")));
    const indicator = new SqsHealthIndicator(client);

    const up = await indicator.check(50);

    expect(up).toBe(false);
  });

  test("resolves to down within its configured timeout when the call never settles, never waiting indefinitely", async () => {
    const hangingCall = new Promise<unknown>(() => {
      // nunca resolve nem rejeita - simula uma chamada pendurada
    });
    const client = withSend(() => hangingCall);
    const indicator = new SqsHealthIndicator(client);

    const startedAt = Date.now();
    const up = await indicator.check(50);
    const elapsedMs = Date.now() - startedAt;

    expect(up).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  test("resolves to up when the underlying GetQueueUrl call resolves", async () => {
    const client = withSend(() => Promise.resolve({ QueueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo" }));
    const indicator = new SqsHealthIndicator(client);

    const up = await indicator.check(50);

    expect(up).toBe(true);
  });

  test("the production default timeout is at most 2000ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  test("the check method with no explicit timeout resolves to down within the 2000ms default when the call hangs", async () => {
    const hangingCall = new Promise<unknown>(() => {
      // nunca resolve nem rejeita - simula uma chamada pendurada
    });
    const client = withSend(() => hangingCall);
    const indicator = new SqsHealthIndicator(client);

    const startedAt = Date.now();
    const up = await indicator.check();
    const elapsedMs = Date.now() - startedAt;

    expect(up).toBe(false);
    expect(elapsedMs).toBeLessThan(DEFAULT_TIMEOUT_MS + 500);
  });
});
