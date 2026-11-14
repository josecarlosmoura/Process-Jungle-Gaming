import { describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { ReprocessPendingReferenceUseCase } from "../../application/use-cases/reprocess-pending-reference.use-case";
import { PendingReferenceReprocessorScheduler } from "./pending-reference-reprocessor.scheduler";

function fakeOrm(): MikroORM {
  // RequestContext.create so chama em.fork({useContext:true}) e guarda o resultado por em.name -
  // nunca faz instanceof MikroORM/EntityManager, entao este shape minimo basta.
  return { em: { name: "default", fork: () => ({}) } } as unknown as MikroORM;
}

function fakeUseCase(execute: () => Promise<void>): ReprocessPendingReferenceUseCase {
  return { execute } as unknown as ReprocessPendingReferenceUseCase;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PendingReferenceReprocessorScheduler", () => {
  test("onApplicationBootstrap starts polling immediately, without waiting for any external coordination", async () => {
    let calls = 0;
    const scheduler = new PendingReferenceReprocessorScheduler(
      fakeOrm(),
      fakeUseCase(async () => {
        calls += 1;
      }),
      1_000,
    );
    try {
      scheduler.onApplicationBootstrap();
      await wait(30);

      expect(calls).toBe(1);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("a cycle whose execute rejects is logged and does not stop the scheduler from running the next cycle", async () => {
    let calls = 0;
    const scheduler = new PendingReferenceReprocessorScheduler(
      fakeOrm(),
      fakeUseCase(async () => {
        calls += 1;
        throw new Error("simulated cycle failure");
      }),
      10,
    );
    try {
      scheduler.onApplicationBootstrap();
      await wait(60);

      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("onModuleDestroy stops scheduling further cycles", async () => {
    let calls = 0;
    const scheduler = new PendingReferenceReprocessorScheduler(
      fakeOrm(),
      fakeUseCase(async () => {
        calls += 1;
      }),
      10,
    );
    scheduler.onApplicationBootstrap();
    await wait(30);
    const callsAtDestroy = calls;
    expect(callsAtDestroy).toBeGreaterThanOrEqual(1);

    scheduler.onModuleDestroy();
    await wait(60);

    expect(calls).toBe(callsAtDestroy);
  });
});
