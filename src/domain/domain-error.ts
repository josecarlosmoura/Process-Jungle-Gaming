import type { FailureCode } from "./failure-code";

export abstract class DomainError extends Error {
  protected constructor(
    message: string,
    public readonly failureCode?: FailureCode,
  ) {
    super(message);
  }
}

export class PayloadValidationError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_PAYLOAD");
    this.name = "PayloadValidationError";
  }
}

export class BusinessRuleRejectionError extends DomainError {
  constructor(message: string, failureCode: FailureCode) {
    super(message, failureCode);
    this.name = "BusinessRuleRejectionError";
  }
}

export class ResourceConflictError extends DomainError {
  constructor(message: string, failureCode?: FailureCode) {
    super(message, failureCode);
    this.name = "ResourceConflictError";
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class TransientInfrastructureError extends DomainError {
  constructor(message: string) {
    super(message, "INTERNAL_ERROR");
    this.name = "TransientInfrastructureError";
  }
}
