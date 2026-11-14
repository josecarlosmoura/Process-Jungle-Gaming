import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { IsolationLevel } from "@mikro-orm/postgresql";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import { Wallet, WalletNotFoundError } from "../../domain/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../../domain/wallet-ledger-entry";
import type { WalletRepository } from "../ports/wallet.repository";
import type { LedgerPagination, WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import { ReconciliationMetrics } from "../reconciliation-metrics";
import { LEDGER_PAGE_SIZE, ReconcileWalletUseCase } from "./reconcile-wallet.use-case";

const SECRET = "test-secret";

let errors: string[] = [];

beforeEach(() => {
  errors = [];
  Logger.overrideLogger({
    log: () => {},
    error: (message: unknown) => {
      errors.push(String(message));
    },
    warn: () => {},
    debug: () => {},
    verbose: () => {},
  });
});

afterEach(() => {
  Logger.overrideLogger(new ConsoleLogger());
});

function fakeEntityManager(): { em: EntityManager; capturedOptions: () => unknown } {
  let capturedOptions: unknown;
  const em = {
    transactional: async (cb: () => unknown, options: unknown) => {
      capturedOptions = options;
      return cb();
    },
  };
  return { em: em as unknown as EntityManager, capturedOptions: () => capturedOptions };
}

function fakeWalletRepo(wallet: Wallet | null): WalletRepository {
  return {
    findById: async () => wallet,
    findByIdForUpdate: async () => {
      throw new Error("ReconcileWalletUseCase must never take a pessimistic lock on the wallet");
    },
    findByPlayerAndCurrency: async () => null,
    save: async () => {
      throw new Error("ReconcileWalletUseCase must never write to the wallet - it is read-only");
    },
  };
}

function fakeLedgerRepo(pages: WalletLedgerEntry[][]): {
  repo: WalletLedgerEntryRepository;
  callCount: () => number;
} {
  let callIndex = 0;
  const repo: WalletLedgerEntryRepository = {
    save: async () => {
      throw new Error("ReconcileWalletUseCase must never write to the ledger - it is read-only");
    },
    findByTransactionId: async () => null,
    findByWalletId: async (_walletId: string, _pagination: LedgerPagination) => {
      const page = pages[callIndex] ?? [];
      callIndex += 1;
      return page;
    },
  };
  return { repo, callCount: () => callIndex };
}

function makeEntry(direction: LedgerDirection, amount: string): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: randomUUID(),
    walletId: "wallet-1",
    transactionId: randomUUID(),
    direction,
    money: Money.from({ amount, currency: "BRL" }),
    balanceBefore: Money.zero("BRL"),
    balanceAfter: Money.zero("BRL"),
    createdAt: new Date(),
  });
}

function makeUseCase(
  wallet: Wallet | null,
  pages: WalletLedgerEntry[][],
  metrics: ReconciliationMetrics = new ReconciliationMetrics(),
) {
  const { em, capturedOptions } = fakeEntityManager();
  const { repo: ledgerRepo, callCount } = fakeLedgerRepo(pages);
  const useCase = new ReconcileWalletUseCase(em, fakeWalletRepo(wallet), ledgerRepo, metrics, SECRET);
  return { useCase, capturedOptions, callCount, metrics };
}

describe("ReconcileWalletUseCase", () => {
  test("computes consistent true with difference zero when storedBalance matches the ledger sum", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
    const { useCase } = makeUseCase(wallet, [[makeEntry("CREDIT", "150.00"), makeEntry("DEBIT", "50.00")]]);

    const result = await useCase.execute("wallet-1");

    expect(result.consistent).toBe(true);
    expect(result.difference.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(result.checkedEntries).toBe(2);
  });

  test("computes consistent false with a correctly signed difference when storedBalance disagrees with the ledger", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "101.00", currency: "BRL" }) });
    const { useCase } = makeUseCase(wallet, [[makeEntry("CREDIT", "150.00"), makeEntry("DEBIT", "50.00")]]);

    const result = await useCase.execute("wallet-1");

    expect(result.consistent).toBe(false);
    expect(result.storedBalance.toJSON()).toEqual({ amount: "101.00", currency: "BRL" });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(result.difference.toJSON()).toEqual({ amount: "1.00", currency: "BRL" });
  });

  test("logs a structured error naming walletId, storedBalance, calculatedBalance and difference only when inconsistent", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "101.00", currency: "BRL" }) });
    const { useCase } = makeUseCase(wallet, [[makeEntry("CREDIT", "100.00")]]);

    await useCase.execute("wallet-1");

    expect(errors.length).toBe(1);
    const logged = JSON.parse(errors[0] as string);
    expect(logged.walletId).toBe("wallet-1");
    expect(logged.storedBalance).toEqual({ amount: "101.00", currency: "BRL" });
    expect(logged.calculatedBalance).toEqual({ amount: "100.00", currency: "BRL" });
    expect(logged.difference).toEqual({ amount: "1.00", currency: "BRL" });
  });

  test("never logs and never increments the divergence counter when consistent", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
    const { useCase, metrics } = makeUseCase(wallet, [[makeEntry("CREDIT", "100.00")]]);

    await useCase.execute("wallet-1");

    expect(errors).toEqual([]);
    expect(metrics.divergenceCount).toBe(0);
  });

  test("increments the divergence counter by exactly 1 when inconsistent", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "101.00", currency: "BRL" }) });
    const { useCase, metrics } = makeUseCase(wallet, [[makeEntry("CREDIT", "100.00")]]);

    await useCase.execute("wallet-1");

    expect(metrics.divergenceCount).toBe(1);
  });

  test("never writes to the wallet or the ledger, and never takes a pessimistic lock, as a side effect of reconciling", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
    const { useCase } = makeUseCase(wallet, [[makeEntry("CREDIT", "100.00")]]);

    // As fakes de WalletRepository/WalletLedgerEntryRepository lancam se save()/findByIdForUpdate()
    // forem chamados - um execute() que resolve sem rejeitar ja prova a ausencia dessas chamadas.
    await expect(useCase.execute("wallet-1")).resolves.toBeDefined();
  });

  test("sums correctly across more than one internal page of the ledger", async () => {
    const firstPage = Array.from({ length: LEDGER_PAGE_SIZE }, () => makeEntry("CREDIT", "1.00"));
    const secondPage = [makeEntry("CREDIT", "1.00")];
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: (LEDGER_PAGE_SIZE + 1).toFixed(2), currency: "BRL" }),
    });
    const { useCase, callCount } = makeUseCase(wallet, [firstPage, secondPage]);

    const result = await useCase.execute("wallet-1");

    expect(callCount()).toBe(2);
    expect(result.checkedEntries).toBe(LEDGER_PAGE_SIZE + 1);
    expect(result.consistent).toBe(true);
  });

  test("requests REPEATABLE READ isolation with no pessimistic lock", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "0.00", currency: "BRL" }) });
    const { useCase, capturedOptions } = makeUseCase(wallet, [[]]);

    await useCase.execute("wallet-1");

    expect(capturedOptions()).toEqual({ isolationLevel: IsolationLevel.REPEATABLE_READ });
  });

  test("throws WalletNotFoundError when the wallet does not exist", async () => {
    const { useCase } = makeUseCase(null, [[]]);

    await expect(useCase.execute(randomUUID())).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test("computes checkedEntries 0 and calculatedBalance 0.00 for a wallet with no ledger entries", async () => {
    const wallet = Wallet.open({ id: "wallet-1", playerId: randomUUID(), initialBalance: Money.from({ amount: "0.00", currency: "BRL" }) });
    const { useCase } = makeUseCase(wallet, [[]]);

    const result = await useCase.execute("wallet-1");

    expect(result.checkedEntries).toBe(0);
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.consistent).toBe(true);
  });
});
