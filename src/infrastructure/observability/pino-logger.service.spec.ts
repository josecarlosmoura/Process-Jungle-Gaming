import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { LogContextService } from "./log-context.service";
import { PinoLoggerService } from "./pino-logger.service";

function captureLines(): { destination: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    destination,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
  };
}

describe("PinoLoggerService", () => {
  test("emits a single valid JSON line with level and a timestamp field for a plain string message", () => {
    const { destination, lines } = captureLines();
    const logger = new PinoLoggerService(destination);

    logger.warn("3 mensagens detectadas", "DlqMonitorScheduler");

    const [line] = lines();
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    expect(typeof line?.timestamp).toBe("string");
    expect(new Date(line?.timestamp as string).toString()).not.toBe("Invalid Date");
    expect(line?.msg).toBe("3 mensagens detectadas");
    expect(line?.context).toBe("DlqMonitorScheduler");
  });

  test("merges the ambient LogContextService fields into an existing plain-string call site, with no call-site change", () => {
    const { destination, lines } = captureLines();
    const logger = new PinoLoggerService(destination);

    LogContextService.run({ correlationId: "corr-1", walletId: "wallet-1" }, () => {
      logger.error("falha ao receber mensagens", undefined, "WagerTransactionSqsConsumer");
    });

    const [line] = lines();
    expect(line?.correlationId).toBe("corr-1");
    expect(line?.walletId).toBe("wallet-1");
    expect(line?.context).toBe("WagerTransactionSqsConsumer");
  });

  test("accepts a structured merging object as the message, without double-encoding it as a string", () => {
    const { destination, lines } = captureLines();
    const logger = new PinoLoggerService(destination);

    LogContextService.run({ correlationId: "corr-2", transactionId: "tx-1" }, () => {
      logger.error({ event: "wager_transaction_outcome", status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" }, "transaction rejected");
    });

    const [line] = lines();
    expect(line?.event).toBe("wager_transaction_outcome");
    expect(line?.status).toBe("REJECTED");
    expect(line?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(line?.correlationId).toBe("corr-2");
    expect(line?.transactionId).toBe("tx-1");
    expect(line?.msg).toBe("transaction rejected");
    // Nunca aninhado como string JSON escapada dentro de "msg" - teria sido o resultado de
    // JSON.stringify(obj) passado como message no estilo antigo.
    const msg = line?.msg as string | undefined;
    expect(typeof msg).toBe("string");
    expect(msg?.startsWith("{") ?? true).toBe(false);
  });

  test("works transparently through NestJS's own Logger facade via Logger.overrideLogger", () => {
    const { destination, lines } = captureLines();
    const pinoLogger = new PinoLoggerService(destination);
    Logger.overrideLogger(pinoLogger);
    try {
      const logger = new Logger("SomeClass");
      logger.log("hello");

      const [line] = lines();
      expect(line?.level).toBe("info");
      expect(line?.msg).toBe("hello");
      expect(line?.context).toBe("SomeClass");
    } finally {
      Logger.overrideLogger(new Logger());
    }
  });
});
