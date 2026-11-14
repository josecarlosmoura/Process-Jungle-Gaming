import { describe, expect, test } from "bun:test";
import {
  InvalidWagerTransactionEnvelopeError,
  parseWagerTransactionRequestedEnvelope,
  toProcessWagerTransactionCommand,
} from "./wager-transaction-requested-envelope";

function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: "provider-a:transaction-123",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...overrides,
    },
  });
}

describe("wager-transaction-requested-envelope", () => {
  test("parses a valid envelope and throws on invalid JSON or a schema mismatch in data", () => {
    const envelope = parseWagerTransactionRequestedEnvelope(
      validBody({ referenceExternalTransactionId: "bet-ref-1", kind: "ROLLBACK" }),
    );
    const command = toProcessWagerTransactionCommand(envelope);

    expect(envelope.messageId).toBe("msg-123");
    expect(command).toMatchObject({
      idempotencyKey: "provider-a:transaction-123",
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "ROLLBACK",
      referenceExternalTransactionId: "bet-ref-1",
    });
    expect(command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });

    expect(() => parseWagerTransactionRequestedEnvelope("not json")).toThrow(InvalidWagerTransactionEnvelopeError);
    expect(() => parseWagerTransactionRequestedEnvelope(validBody({ walletId: "not-a-uuid" }))).toThrow(
      InvalidWagerTransactionEnvelopeError,
    );
    expect(() => parseWagerTransactionRequestedEnvelope(validBody({ kind: "REFUND" }))).toThrow(
      InvalidWagerTransactionEnvelopeError,
    );
  });
});
