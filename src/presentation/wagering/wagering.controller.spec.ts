import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Money } from "../../domain/money";
import { WagerTransaction } from "../../domain/wager-transaction";
import { toGetResponseBody } from "./wagering.controller";

function makePendingBet(): WagerTransaction {
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: `provider-a:${randomUUID()}`,
    payloadHash: "a".repeat(64),
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
  });
}

describe("WageringController.toGetResponseBody", () => {
  test("includes only status kind and money for a PENDING transaction", () => {
    const transaction = makePendingBet();

    const body = toGetResponseBody(transaction);

    expect(body).toEqual({
      status: "PENDING",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });
  });

  test("includes failureCode and processedAt for a FAILED transaction", () => {
    const transaction = makePendingBet();
    transaction.fail("INTERNAL_ERROR");

    const body = toGetResponseBody(transaction);

    expect(body.status).toBe("FAILED");
    expect(body.failureCode).toBe("INTERNAL_ERROR");
    expect(body.processedAt).toBeInstanceOf(Date);
    expect(body.referenceTransactionId).toBeUndefined();
  });
});
