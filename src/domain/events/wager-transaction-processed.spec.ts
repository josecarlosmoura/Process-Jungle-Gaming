import { describe, expect, test } from "bun:test";
import { Money } from "../money";
import { WagerTransaction } from "../wager-transaction";
import { WagerTransactionProcessed } from "./wager-transaction-processed";

describe("WagerTransactionProcessed.from", () => {
  test("from builds eventType WagerTransactionProcessed, version 1, aggregateId equal to walletId and MoneyProps in data, never a Money instance", () => {
    const transaction = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-1",
      externalTransactionId: "ext-1",
      idempotencyKey: "idem-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
    });
    transaction.markProcessed(undefined, new Date("2026-03-01T00:00:00.000Z"));
    const balance = Money.from({ amount: "90.00", currency: "BRL" }).toJSON();
    const ctx = { correlationId: "correlation-1", occurredAt: new Date("2026-03-01T00:00:00.000Z") };

    const event = WagerTransactionProcessed.from(transaction, balance, ctx);

    expect(event.eventType).toBe("WagerTransactionProcessed");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data).toEqual({
      transactionId: "tx-1",
      walletId: "wallet-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      referenceTransactionId: undefined,
      balance: { amount: "90.00", currency: "BRL" },
    });
    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(event.data.balance).not.toBeInstanceOf(Money);
  });
});
