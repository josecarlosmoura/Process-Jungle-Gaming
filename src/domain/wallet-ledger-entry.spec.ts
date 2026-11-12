import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "./money";
import { UnbalancedLedgerEntryError, WalletLedgerEntry, type CreateLedgerEntryProps, type LedgerEntryState } from "./wallet-ledger-entry";

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function buildProps(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: nextId("entry"),
    walletId: "wallet-1",
    transactionId: nextId("tx"),
    direction: "DEBIT",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
    balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
    ...overrides,
  };
}

function buildState(overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: nextId("entry"),
    walletId: "wallet-1",
    transactionId: nextId("tx"),
    direction: "DEBIT",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
    balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("WalletLedgerEntry", () => {
  test("create with direction DEBIT and correct arithmetic returns an instance with the exact fields passed", () => {
    const props = buildProps({
      direction: "DEBIT",
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
    });

    const entry = WalletLedgerEntry.create(props);

    expect(entry.id).toBe(props.id);
    expect(entry.walletId).toBe(props.walletId);
    expect(entry.transactionId).toBe(props.transactionId);
    expect(entry.direction).toBe("DEBIT");
    expect(entry.money.equals(props.money)).toBe(true);
    expect(entry.balanceBefore.equals(props.balanceBefore)).toBe(true);
    expect(entry.balanceAfter.equals(props.balanceAfter)).toBe(true);
  });

  test("create with direction CREDIT and correct arithmetic returns an instance with the exact fields passed", () => {
    const props = buildProps({
      direction: "CREDIT",
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
    });

    const entry = WalletLedgerEntry.create(props);

    expect(entry.id).toBe(props.id);
    expect(entry.walletId).toBe(props.walletId);
    expect(entry.transactionId).toBe(props.transactionId);
    expect(entry.direction).toBe("CREDIT");
    expect(entry.money.equals(props.money)).toBe(true);
    expect(entry.balanceBefore.equals(props.balanceBefore)).toBe(true);
    expect(entry.balanceAfter.equals(props.balanceAfter)).toBe(true);
  });

  test("create throws UnbalancedLedgerEntryError when balanceAfter does not match the expected arithmetic, for both DEBIT and CREDIT", () => {
    const debitProps = buildProps({
      direction: "DEBIT",
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "80.00", currency: "BRL" }),
    });
    expect(() => WalletLedgerEntry.create(debitProps)).toThrow(UnbalancedLedgerEntryError);

    const creditProps = buildProps({
      direction: "CREDIT",
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "120.00", currency: "BRL" }),
    });
    expect(() => WalletLedgerEntry.create(creditProps)).toThrow(UnbalancedLedgerEntryError);
  });

  test("isBalanced returns true for an instance created by create", () => {
    const entry = WalletLedgerEntry.create(buildProps());

    expect(entry.isBalanced()).toBe(true);
  });

  test("isBalanced returns false, without throwing, for a rehydrated instance with inconsistent arithmetic", () => {
    const entry = WalletLedgerEntry.rehydrate(
      buildState({
        direction: "DEBIT",
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "80.00", currency: "BRL" }),
      }),
    );

    expect(entry.isBalanced()).toBe(false);
  });

  test("create throws CurrencyMismatchError when money and balanceBefore are in different currencies", () => {
    const props = buildProps({
      money: Money.from({ amount: "25.00", currency: "USD" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
    });

    expect(() => WalletLedgerEntry.create(props)).toThrow(CurrencyMismatchError);
  });

  test("isBalanced returns false, without throwing, for a rehydrated instance with mismatched currencies", () => {
    const entry = WalletLedgerEntry.rehydrate(
      buildState({
        money: Money.from({ amount: "25.00", currency: "USD" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
      }),
    );

    expect(entry.isBalanced()).toBe(false);
  });

  test("rehydrate reconstructs the exact state passed, without throwing", () => {
    const state = buildState({
      direction: "CREDIT",
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const entry = WalletLedgerEntry.rehydrate(state);

    expect(entry.id).toBe(state.id);
    expect(entry.walletId).toBe(state.walletId);
    expect(entry.transactionId).toBe(state.transactionId);
    expect(entry.direction).toBe(state.direction);
    expect(entry.money.equals(state.money)).toBe(true);
    expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
    expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
    expect(entry.createdAt).toBe(state.createdAt);
  });

  test("rehydrate reconstructs a state that would violate create's arithmetic or currency invariant, without throwing any validation error", () => {
    const inconsistentArithmetic = buildState({
      direction: "DEBIT",
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "999.00", currency: "BRL" }),
    });
    expect(() => WalletLedgerEntry.rehydrate(inconsistentArithmetic)).not.toThrow();

    const inconsistentCurrency = buildState({
      direction: "CREDIT",
      money: Money.from({ amount: "25.00", currency: "USD" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "125.00", currency: "BRL" }),
    });
    expect(() => WalletLedgerEntry.rehydrate(inconsistentCurrency)).not.toThrow();
  });

  test("the instance prototype exposes no method besides isBalanced and the constructor", () => {
    const prototypeMembers = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).sort();
    expect(prototypeMembers).toEqual(["constructor", "isBalanced"]);

    // A asserção acima, isolada, é cega a um campo mutável ou a um método declarado como
    // arrow function (campo de classe): ambos vivem na instância, nunca no prototype. Fechando
    // também o conjunto de propriedades próprias da instância, nenhum dos dois passaria sem ser pego.
    const entry = WalletLedgerEntry.create(buildProps());
    const instanceMembers = Object.getOwnPropertyNames(entry).sort();
    expect(instanceMembers).toEqual(
      ["balanceAfter", "balanceBefore", "createdAt", "direction", "id", "money", "transactionId", "walletId"].sort(),
    );
  });
});
