import { describe, expect, test } from "bun:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import { DEFAULT_TIMEOUT_MS, PostgresHealthIndicator } from "./postgres-health.indicator";

function withExecute(execute: () => Promise<unknown>): EntityManager {
  return {
    getConnection: () => ({ execute }),
  } as unknown as EntityManager;
}

describe("PostgresHealthIndicator", () => {
  test("resolves to down when the underlying connection query rejects", async () => {
    const em = withExecute(() => Promise.reject(new Error("connection refused")));
    const indicator = new PostgresHealthIndicator(em);

    const up = await indicator.check(50);

    expect(up).toBe(false);
  });

  test("resolves to down within its configured timeout when the query never settles, never waiting indefinitely", async () => {
    const hangingQuery = new Promise<unknown>(() => {
      // nunca resolve nem rejeita - simula uma conexao pendurada
    });
    const em = withExecute(() => hangingQuery);
    const indicator = new PostgresHealthIndicator(em);

    const startedAt = Date.now();
    const up = await indicator.check(50);
    const elapsedMs = Date.now() - startedAt;

    expect(up).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  test("resolves to up when the underlying connection query resolves", async () => {
    const em = withExecute(() => Promise.resolve([{ "?column?": 1 }]));
    const indicator = new PostgresHealthIndicator(em);

    const up = await indicator.check(50);

    expect(up).toBe(true);
  });

  test("the production default timeout is at most 2000ms, per AC 8", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  test("the check method with no explicit timeout resolves to down within the 2000ms default when the query hangs", async () => {
    const hangingQuery = new Promise<unknown>(() => {
      // nunca resolve nem rejeita - simula uma conexao pendurada
    });
    const em = withExecute(() => hangingQuery);
    const indicator = new PostgresHealthIndicator(em);

    const startedAt = Date.now();
    const up = await indicator.check();
    const elapsedMs = Date.now() - startedAt;

    expect(up).toBe(false);
    expect(elapsedMs).toBeLessThan(DEFAULT_TIMEOUT_MS + 500);
  });
});
