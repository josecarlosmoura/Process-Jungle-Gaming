import { describe, expect, test } from "bun:test";
import { Money } from "../money";
import { Wallet } from "../wallet";
import { WalletLedgerEntry } from "../wallet-ledger-entry";
import { WalletBalanceChanged } from "./wallet-balance-changed";

describe("WalletBalanceChanged.from", () => {
  test("from builds exactly walletId, transactionId, direction, money, balanceBefore, balanceAfter and walletVersion in data", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    wallet.debit(Money.from({ amount: "10.00", currency: "BRL" }));
    const entry = WalletLedgerEntry.create({
      id: "entry-1",
      walletId: wallet.id,
      transactionId: "tx-1",
      direction: "DEBIT",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "90.00", currency: "BRL" }),
    });
    const ctx = { correlationId: "correlation-1", occurredAt: new Date("2026-03-01T00:00:00.000Z") };

    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data).toEqual({
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: "DEBIT",
      money: { amount: "10.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "90.00", currency: "BRL" },
      walletVersion: 2,
    });
    expect(Object.keys(event.data).sort()).toEqual(
      ["walletId", "transactionId", "direction", "money", "balanceBefore", "balanceAfter", "walletVersion"].sort(),
    );
  });
});
