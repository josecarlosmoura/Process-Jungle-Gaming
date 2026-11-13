import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "./money";
import { InsufficientFundsError, Wallet, type WalletState } from "./wallet";

describe("Wallet", () => {
  test("open creates an instance with version 1 and the exact positive initial balance", () => {
    const initialBalance = Money.from({ amount: "100.00", currency: "BRL" });
    const wallet = Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance });

    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
  });

  test("open creates an instance with version 1 when the initial balance is zero", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
  });

  test("debit with sufficient balance reduces the balance and increments the version, including when the amount exactly equals the balance", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const updatedAtBeforeDebit = wallet.updatedAt;

    wallet.debit(Money.from({ amount: "40.00", currency: "BRL" }));

    expect(wallet.balance.toJSON()).toEqual({ amount: "60.00", currency: "BRL" });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBeGreaterThanOrEqual(updatedAtBeforeDebit.getTime());

    wallet.debit(Money.from({ amount: "60.00", currency: "BRL" }));

    expect(wallet.balance.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(wallet.version).toBe(3);
  });

  test("debit with insufficient balance throws InsufficientFundsError without changing balance, version or updatedAt", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;

    expect(() => wallet.debit(Money.from({ amount: "100.01", currency: "BRL" }))).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON()).toEqual(balanceBefore.toJSON());
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toBe(updatedAtBefore);
  });

  test("credit increases the balance and increments the version", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const updatedAtBeforeCredit = wallet.updatedAt;

    wallet.credit(Money.from({ amount: "25.00", currency: "BRL" }));

    expect(wallet.balance.toJSON()).toEqual({ amount: "125.00", currency: "BRL" });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBeGreaterThanOrEqual(updatedAtBeforeCredit.getTime());
  });

  test("debit and credit with a zero-amount money leave balance, version and updatedAt unchanged", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;
    const zero = Money.zero("BRL");

    wallet.debit(zero);
    expect(wallet.balance.toJSON()).toEqual(balanceBefore.toJSON());
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toBe(updatedAtBefore);

    wallet.credit(zero);
    expect(wallet.balance.toJSON()).toEqual(balanceBefore.toJSON());
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toBe(updatedAtBefore);
  });

  test("debit and credit throw CurrencyMismatchError for a different currency, without changing balance, version or updatedAt", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const usdMoney = Money.from({ amount: "10.00", currency: "USD" });
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;

    expect(() => wallet.debit(usdMoney)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usdMoney)).toThrow(CurrencyMismatchError);

    expect(wallet.balance.toJSON()).toEqual(balanceBefore.toJSON());
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toBe(updatedAtBefore);
  });

  test("hasCurrency returns true for the wallet's own currency and false for any other, without mutating balance, version or updatedAt", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    const updatedAtBefore = wallet.updatedAt;

    expect(wallet.hasCurrency("BRL")).toBe(true);
    expect(wallet.hasCurrency("USD")).toBe(false);

    expect(wallet.balance.toJSON()).toEqual(balanceBefore.toJSON());
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.updatedAt).toBe(updatedAtBefore);
  });

  test("rehydrate reconstructs the exact state passed, without throwing", () => {
    const state: WalletState = {
      id: "wallet-1",
      playerId: "player-1",
      balance: Money.from({ amount: "42.50", currency: "BRL" }),
      version: 7,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    };

    const wallet = Wallet.rehydrate(state);

    expect(wallet.balance.toJSON()).toEqual({ amount: "42.50", currency: "BRL" });
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(state.updatedAt);
  });

  test("rehydrate reconstructs a state that would violate open's invariants, without throwing any validation error", () => {
    const invalidState: WalletState = {
      id: "wallet-1",
      playerId: "player-1",
      balance: Money.from({ amount: "-50.00", currency: "BRL" }, { allowNegative: true }),
      version: 99,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(() => Wallet.rehydrate(invalidState)).not.toThrow();

    const wallet = Wallet.rehydrate(invalidState);
    expect(wallet.balance.toJSON()).toEqual({ amount: "-50.00", currency: "BRL" });
    expect(wallet.version).toBe(99);
  });
});
