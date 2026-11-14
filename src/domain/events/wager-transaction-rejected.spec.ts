import { describe, expect, test } from "bun:test";
import { Money } from "../money";
import { WagerTransaction } from "../wager-transaction";
import { WagerTransactionRejected } from "./wager-transaction-rejected";

describe("WagerTransactionRejected.from", () => {
  test("from builds eventType WagerTransactionRejected, version 1 and the transaction's failureCode in data", () => {
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
    transaction.reject("INSUFFICIENT_FUNDS");
    const ctx = { correlationId: "correlation-1", occurredAt: new Date("2026-03-01T00:00:00.000Z") };

    const event = WagerTransactionRejected.from(transaction, ctx);

    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data).toEqual({
      transactionId: "tx-1",
      walletId: "wallet-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      failureCode: "INSUFFICIENT_FUNDS",
    });
    expect(event.data.money).not.toBeInstanceOf(Money);
  });
});
