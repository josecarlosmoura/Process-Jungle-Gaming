import { describe, expect, test } from "bun:test";
import type { FailureCode } from "./failure-code";

const ALL_FAILURE_CODES: readonly FailureCode[] = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_ALREADY_REVERSED",
  "REFERENCE_AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_PAYLOAD",
  "INTERNAL_ERROR",
];

// Compila só se ALL_FAILURE_CODES cobrir toda a union - um membro de FailureCode ausente da lista
// acima quebra o build aqui, nunca em silêncio em outro arquivo.
function assertExhaustive(code: FailureCode): FailureCode {
  switch (code) {
    case "INSUFFICIENT_FUNDS":
    case "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE":
    case "REFERENCE_NOT_FOUND":
    case "REFERENCE_MISMATCH":
    case "REFERENCE_ALREADY_REVERSED":
    case "REFERENCE_AMOUNT_MISMATCH":
    case "CURRENCY_MISMATCH":
    case "IDEMPOTENCY_CONFLICT":
    case "INVALID_PAYLOAD":
    case "INTERNAL_ERROR":
      return code;
    default: {
      const neverReached: never = code;
      return neverReached;
    }
  }
}

describe("FailureCode", () => {
  test("has exactly the 10 documented literal members, closed by an exhaustive switch", () => {
    expect(ALL_FAILURE_CODES.length).toBe(10);
    expect(new Set(ALL_FAILURE_CODES).size).toBe(10);
    for (const code of ALL_FAILURE_CODES) {
      expect(assertExhaustive(code)).toBe(code);
    }
  });
});
