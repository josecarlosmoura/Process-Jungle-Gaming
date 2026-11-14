import { describe, expect, test } from "bun:test";
import {
  BusinessRuleRejectionError,
  isTransientInfrastructureFailure,
  PayloadValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from "./domain-error";

describe("DomainError categories", () => {
  test("each of the 5 concrete DomainError categories carries exactly the failureCode its category defines", () => {
    const cases: Array<{ error: { failureCode?: string }; expected: string | undefined }> = [
      { error: new PayloadValidationError("invalid payload"), expected: "INVALID_PAYLOAD" },
      { error: new BusinessRuleRejectionError("rejected", "INSUFFICIENT_FUNDS"), expected: "INSUFFICIENT_FUNDS" },
      { error: new ResourceConflictError("conflict with code", "IDEMPOTENCY_CONFLICT"), expected: "IDEMPOTENCY_CONFLICT" },
      { error: new ResourceConflictError("conflict without code"), expected: undefined },
      { error: new ResourceNotFoundError("not found"), expected: undefined },
      { error: new TransientInfrastructureError("infra down"), expected: "INTERNAL_ERROR" },
    ];

    for (const { error, expected } of cases) {
      expect(error.failureCode).toBe(expected);
    }
  });

  test("each category preserves the message passed to its constructor and sets its own name", () => {
    expect(new PayloadValidationError("bad payload").message).toBe("bad payload");
    expect(new PayloadValidationError("bad payload").name).toBe("PayloadValidationError");
    expect(new ResourceNotFoundError("gone").name).toBe("ResourceNotFoundError");
  });
});

describe("isTransientInfrastructureFailure", () => {
  test("classifies TransientInfrastructureError and unknown errors as transient, every other DomainError category as permanent", () => {
    const cases: Array<{ error: unknown; expected: boolean }> = [
      { error: new TransientInfrastructureError("infra down"), expected: true },
      { error: new PayloadValidationError("invalid payload"), expected: false },
      { error: new BusinessRuleRejectionError("rejected", "INSUFFICIENT_FUNDS"), expected: false },
      { error: new ResourceConflictError("conflict"), expected: false },
      { error: new ResourceNotFoundError("not found"), expected: false },
      { error: new Error("unmapped bug"), expected: true },
    ];

    for (const { error, expected } of cases) {
      expect(isTransientInfrastructureFailure(error)).toBe(expected);
    }
  });
});
