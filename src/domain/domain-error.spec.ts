import { describe, expect, test } from "bun:test";
import {
  BusinessRuleRejectionError,
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
