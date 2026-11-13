import { describe, expect, test } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";
import {
  BusinessRuleRejectionError,
  PayloadValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from "../../domain/domain-error";
import { DomainErrorExceptionFilter } from "./domain-error-exception.filter";

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
}

function fakeHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const response = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe("DomainErrorExceptionFilter", () => {
  test("a PayloadValidationError responds 400 with failureCode INVALID_PAYLOAD and the error's own message", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();

    filter.catch(new PayloadValidationError('kind "REFUND" is not supported yet'), host);

    expect(captured.statusCode).toBe(400);
    expect(captured.body).toEqual({ failureCode: "INVALID_PAYLOAD", message: 'kind "REFUND" is not supported yet' });
  });

  test("a ResourceNotFoundError responds 404 with the error's own message and no failureCode key", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();

    filter.catch(new ResourceNotFoundError('Wallet "abc" was not found'), host);

    expect(captured.statusCode).toBe(404);
    expect(captured.body).toEqual({ message: 'Wallet "abc" was not found' });
  });

  test("a ResourceConflictError responds 409, with failureCode present only when the thrown instance carries one", () => {
    const filter = new DomainErrorExceptionFilter();

    const withCode = fakeHost();
    filter.catch(new ResourceConflictError("Idempotency-Key reused with a different payload", "IDEMPOTENCY_CONFLICT"), withCode.host);
    expect(withCode.captured.statusCode).toBe(409);
    expect(withCode.captured.body).toEqual({
      failureCode: "IDEMPOTENCY_CONFLICT",
      message: "Idempotency-Key reused with a different payload",
    });

    const withoutCode = fakeHost();
    filter.catch(new ResourceConflictError("A wallet already exists"), withoutCode.host);
    expect(withoutCode.captured.statusCode).toBe(409);
    expect(withoutCode.captured.body).toEqual({ message: "A wallet already exists" });
  });

  test("a TransientInfrastructureError responds 503 with failureCode INTERNAL_ERROR", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();

    filter.catch(new TransientInfrastructureError("Lock not acquired before lock_timeout elapsed"), host);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ failureCode: "INTERNAL_ERROR", message: "Lock not acquired before lock_timeout elapsed" });
  });

  test("an HttpException that is not a DomainError is forwarded with its own status and body unchanged", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();
    const original = new BadRequestException(["walletId: must be a valid UUID"]);

    filter.catch(original, host);

    expect(captured.statusCode).toBe(original.getStatus());
    expect(captured.body).toEqual(original.getResponse());
  });

  test("an error that is neither an HttpException nor a DomainError responds 500 with no failureCode, regardless of its own message or name", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();

    class SomeGenuineBug extends Error {
      constructor() {
        super("WagerTransaction cannot markProcessed from status PROCESSED");
        this.name = "InvalidTransactionStateError";
      }
    }

    filter.catch(new SomeGenuineBug(), host);

    expect(captured.statusCode).toBe(500);
    expect(captured.body).toEqual({ message: "Internal server error" });
  });

  test("a case reserved for a future business-rule rejection also maps correctly: BusinessRuleRejectionError responds 422 with the caller's failureCode", () => {
    const filter = new DomainErrorExceptionFilter();
    const { host, captured } = fakeHost();

    filter.catch(new BusinessRuleRejectionError("insufficient funds", "INSUFFICIENT_FUNDS"), host);

    expect(captured.statusCode).toBe(422);
    expect(captured.body).toEqual({ failureCode: "INSUFFICIENT_FUNDS", message: "insufficient funds" });
  });
});
