import { describe, expect, test } from "bun:test";
import { Money } from "../money";
import { WagerTransaction } from "../wager-transaction";
import { WagerTransactionPendingReference } from "./wager-transaction-pending-reference";

describe("WagerTransactionPendingReference.from", () => {
  test("from builds transactionId, walletId, kind, referenceExternalTransactionId, attempts and nextAttemptAt as an ISO string", () => {
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
      kind: "REFUND",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-missing",
    });
    transaction.markPendingReference(new Date("2026-03-01T00:00:00.000Z"));
    const ctx = { correlationId: "correlation-1", occurredAt: new Date("2026-03-01T00:00:00.000Z") };

    const event = WagerTransactionPendingReference.from(transaction, ctx);

    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data).toEqual({
      transactionId: "tx-1",
      walletId: "wallet-1",
      kind: "REFUND",
      referenceExternalTransactionId: "ext-missing",
      attempts: 0,
      nextAttemptAt: "2026-03-01T00:01:00.000Z",
    });
  });
});
