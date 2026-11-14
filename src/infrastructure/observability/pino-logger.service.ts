import type { Writable } from "node:stream";
import type { LoggerService } from "@nestjs/common";
import pino, { type Logger as Pino } from "pino";
import { LogContextService } from "./log-context.service";

type PinoLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// ARCHITECTURE.md secao 12.1 pede a chave "timestamp", nao a "time" padrao do pino - mesmo
// formato de pino.stdTimeFunctions.isoTime, so com o nome da chave trocado.
function isoTimestamp(): string {
  return `,"timestamp":"${new Date().toISOString()}"`;
}

// LoggerService do NestJS, nunca estendendo a classe Logger (SKILL/convencao do proprio NestJS -
// "extends Logger" e proibido desde o Nest v9). Registrado via app.useLogger() em main.ts;
// Logger.overrideLogger() por baixo dos panos faz todo "new Logger(X).warn(...)" existente (7
// arquivos, nenhum editado por esta feature) passar a escrever por aqui.
export class PinoLoggerService implements LoggerService {
  private readonly pino: Pino;

  // destination so existe para teste (um stream em memoria) - em producao, pino() sem segundo
  // argumento ja escreve em stdout pela via rapida (SonicBoom), que nao passa por
  // process.stdout.write e por isso nao seria interceptavel de nenhuma outra forma.
  constructor(destination?: Writable) {
    // pino usa numeros (30, 40...) como "level" por padrao - ARCHITECTURE.md secao 12.1 pede o
    // nome (ex.: "warn"), nao o codigo numerico, para a linha ser legivel sem decodificador.
    const options = { timestamp: isoTimestamp, formatters: { level: (label: string) => ({ level: label }) } };
    this.pino = destination ? pino(options, destination) : pino(options);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write("info", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("trace", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  // O NestJS Logger sempre acrescenta o nome da classe (this.context do "new Logger(X)") como o
  // ULTIMO elemento de optionalParams, para log/warn/debug/verbose/fatal; para error(), o
  // primeiro elemento e o stack trace (ou "undefined" quando ausente) e o contexto continua
  // sendo o ultimo. O discriminador entre a chamada antiga (message e string) e a nova desta
  // tarefa (message e um objeto a fundir, ex.: {event, status, failureCode}) e typeof message -
  // nunca a forma de optionalParams, que e ambigua entre "stack trace" e "texto da nova chamada"
  // (os dois sao string).
  private write(level: PinoLevel, message: unknown, optionalParams: unknown[]): void {
    const logContext = LogContextService.get();
    const context =
      optionalParams.length > 0 && typeof optionalParams[optionalParams.length - 1] === "string"
        ? (optionalParams[optionalParams.length - 1] as string)
        : undefined;

    if (message !== null && typeof message === "object" && !(message instanceof Error)) {
      const text = typeof optionalParams[0] === "string" ? optionalParams[0] : undefined;
      this.pino[level]({ ...logContext, context, ...(message as Record<string, unknown>) }, text);
      return;
    }

    const stack =
      optionalParams.length > 1 && typeof optionalParams[0] === "string" ? optionalParams[0] : undefined;
    this.pino[level](
      { ...logContext, context, ...(stack ? { stack } : {}) },
      message instanceof Error ? message.message : String(message),
    );
  }
}
