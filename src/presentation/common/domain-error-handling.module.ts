import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { DomainErrorExceptionFilter } from "./domain-error-exception.filter";

@Module({
  providers: [{ provide: APP_FILTER, useClass: DomainErrorExceptionFilter }],
})
export class DomainErrorHandlingModule {}
