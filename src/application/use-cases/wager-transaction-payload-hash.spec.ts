import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Money } from "../../domain/money";
import {
  canonicalWagerTransactionPayload,
  computeWagerTransactionPayloadHash,
  type WagerTransactionBusinessPayload,
} from "./wager-transaction-payload-hash";

function makePayload(overrides: Partial<WagerTransactionBusinessPayload> = {}): WagerTransactionBusinessPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: "bet-001",
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    ...overrides,
  };
}

describe("computeWagerTransactionPayloadHash", () => {
  test("computeWagerTransactionPayloadHash returns the same hash for the same business payload computed twice", () => {
    const payload = makePayload();

    const first = computeWagerTransactionPayloadHash(payload);
    const second = computeWagerTransactionPayloadHash(makePayload({ ...payload }));

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeWagerTransactionPayloadHash changes when any business field changes", () => {
    const payload = makePayload();
    const changed = makePayload({ ...payload, money: Money.from({ amount: "25.01", currency: "BRL" }) });

    expect(computeWagerTransactionPayloadHash(payload)).not.toBe(computeWagerTransactionPayloadHash(changed));
  });
});

describe("canonicalWagerTransactionPayload", () => {
  test("canonicalWagerTransactionPayload omits referenceExternalTransactionId when absent, instead of serializing it as null", () => {
    const payload = makePayload();

    const canonical = canonicalWagerTransactionPayload(payload);

    expect(canonical.includes("referenceExternalTransactionId")).toBe(false);
    expect(JSON.parse(canonical)).not.toHaveProperty("referenceExternalTransactionId");
  });

  test("canonicalWagerTransactionPayload includes referenceExternalTransactionId when present", () => {
    const payload = makePayload({ referenceExternalTransactionId: "bet-000" });

    const canonical = canonicalWagerTransactionPayload(payload);

    expect(JSON.parse(canonical).referenceExternalTransactionId).toBe("bet-000");
  });

  test("canonicalWagerTransactionPayload orders keys alphabetically, with or without referenceExternalTransactionId", () => {
    const withoutReference = canonicalWagerTransactionPayload(makePayload());
    const withReference = canonicalWagerTransactionPayload(makePayload({ referenceExternalTransactionId: "bet-000" }));

    expect(Object.keys(JSON.parse(withoutReference))).toEqual(
      [
        "externalTransactionId",
        "gameId",
        "kind",
        "money",
        "playerId",
        "providerId",
        "roundId",
        "walletId",
      ].sort(),
    );
    expect(Object.keys(JSON.parse(withReference))).toEqual(
      [
        "externalTransactionId",
        "gameId",
        "kind",
        "money",
        "playerId",
        "providerId",
        "referenceExternalTransactionId",
        "roundId",
        "walletId",
      ].sort(),
    );
  });

  test("canonicalWagerTransactionPayload never includes the Idempotency-Key value", () => {
    const payload = makePayload();

    const canonical = canonicalWagerTransactionPayload(payload);

    expect(canonical.includes("idempotencyKey")).toBe(false);
  });
});
