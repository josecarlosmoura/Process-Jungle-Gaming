import { describe, expect, test } from "bun:test";
import { LogContextService } from "./log-context.service";

describe("LogContextService", () => {
  test("get() returns an empty object when no run() is active", () => {
    expect(LogContextService.get()).toEqual({});
  });

  test("set() inside a run() is visible to later code in the same async chain", async () => {
    await LogContextService.run({ correlationId: "corr-1" }, async () => {
      expect(LogContextService.get()).toEqual({ correlationId: "corr-1" });

      await Promise.resolve();
      LogContextService.set({ walletId: "wallet-1" });

      await Promise.resolve();
      expect(LogContextService.get()).toEqual({ correlationId: "corr-1", walletId: "wallet-1" });
    });
  });

  test("set() outside any run() is a silent no-op, never throws", () => {
    expect(() => LogContextService.set({ walletId: "wallet-x" })).not.toThrow();
    expect(LogContextService.get()).toEqual({});
  });

  test("two concurrent run() calls never see each other's context", async () => {
    const results: Array<string | undefined> = [];
    await Promise.all([
      LogContextService.run({ correlationId: "a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(LogContextService.get().correlationId);
      }),
      LogContextService.run({ correlationId: "b" }, async () => {
        results.push(LogContextService.get().correlationId);
      }),
    ]);

    expect(results.sort()).toEqual(["a", "b"]);
  });

  test("a nested run() starts a fresh scope that does not inherit the outer set() mutations by reference", async () => {
    await LogContextService.run({ correlationId: "outer" }, async () => {
      LogContextService.set({ walletId: "outer-wallet" });

      await LogContextService.run({ correlationId: "inner" }, async () => {
        expect(LogContextService.get()).toEqual({ correlationId: "inner" });
        LogContextService.set({ walletId: "inner-wallet" });
      });

      expect(LogContextService.get()).toEqual({ correlationId: "outer", walletId: "outer-wallet" });
    });
  });
});
