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

// Mesma distincao que DomainErrorExceptionFilter.statusFor() ja mantem para HTTP (AD-007), aqui
// decidindo ack (nunca reentrega) vs. retry - nunca uma segunda lista de instanceof por tipo
// especifico, que teria que lembrar de um novo subtipo de DomainError em dois lugares.
export function isTransientInfrastructureFailure(error: unknown): boolean {
  if (error instanceof DomainError) {
    return error instanceof TransientInfrastructureError;
  }
  // Erro desconhecido (bug ou categoria futura que esqueceu de estender DomainError) - tratado
  // como transitorio por seguranca: nunca ack de algo que ninguem classificou.
  return true;
}
