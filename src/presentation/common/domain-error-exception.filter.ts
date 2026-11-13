import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import {
  BusinessRuleRejectionError,
  DomainError,
  PayloadValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
  TransientInfrastructureError,
} from "../../domain/domain-error";

@Catch()
export class DomainErrorExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof DomainError) {
      response.status(this.statusFor(exception)).json({
        ...(exception.failureCode ? { failureCode: exception.failureCode } : {}),
        message: exception.message,
      });
      return;
    }

    // Nunca remapeado como regra de negocio: um erro que nao e nem HttpException nem DomainError
    // e, por definicao, algo que nenhum ponto do codigo esperava - precisa continuar visivel como
    // bug (500 logado), nunca disfarcado de rejeicao de negocio (422/409/etc).
    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ message: "Internal server error" });
  }

  private statusFor(exception: DomainError): HttpStatus {
    if (exception instanceof PayloadValidationError) {
      return HttpStatus.BAD_REQUEST;
    }
    if (exception instanceof BusinessRuleRejectionError) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }
    if (exception instanceof ResourceConflictError) {
      return HttpStatus.CONFLICT;
    }
    if (exception instanceof ResourceNotFoundError) {
      return HttpStatus.NOT_FOUND;
    }
    if (exception instanceof TransientInfrastructureError) {
      return HttpStatus.SERVICE_UNAVAILABLE;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
