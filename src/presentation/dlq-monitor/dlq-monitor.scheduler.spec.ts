import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConsoleLogger, Logger } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DlqMonitorScheduler } from "./dlq-monitor.scheduler";

let warnings: string[] = [];
let errors: string[] = [];

// Logger.overrideLogger e a API publica do proprio NestJS para trocar a implementacao de log em
// tempo de execucao - captura o aviso real que DlqMonitorScheduler emite sem expor nenhum
// metodo/getter so-de-teste na classe de producao.
beforeEach(() => {
  warnings = [];
  errors = [];
  Logger.overrideLogger({
    log: () => {},
    error: (message: unknown) => {
      errors.push(String(message));
    },
    warn: (message: unknown) => {
      warnings.push(String(message));
    },
    debug: () => {},
    verbose: () => {},
  });
});

afterEach(() => {
  Logger.overrideLogger(new ConsoleLogger());
});

function fakeSqsClient(attributesByCall: Array<Record<string, string> | Error>): {
  client: SQSClient;
  getQueueAttributesCalls: () => number;
} {
  let index = 0;
  let calls = 0;
  const send = async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case "GetQueueUrlCommand":
        return { QueueUrl: "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" };
      case "GetQueueAttributesCommand": {
        calls += 1;
        const attributesOrError =
          attributesByCall[index] ?? attributesByCall[attributesByCall.length - 1];
        index += 1;
        if (attributesOrError instanceof Error) {
          throw attributesOrError;
        }
        return { Attributes: attributesOrError };
      }
      default:
        throw new Error(`unexpected command ${command.constructor.name}`);
    }
  };
  return { client: { send } as unknown as SQSClient, getQueueAttributesCalls: () => calls };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DlqMonitorScheduler", () => {
  test("logs a warning naming the queue and the approximate message count when the DLQ holds messages", async () => {
    const { client } = fakeSqsClient([{ ApproximateNumberOfMessages: "3" }]);
    const scheduler = new DlqMonitorScheduler(client, "wager-transactions-dlq.fifo", 0);

    try {
      scheduler.onApplicationBootstrap();
      await wait(30);

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain("3");
      expect(warnings[0]).toContain("wager-transactions-dlq.fifo");
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("never logs that warning while the DLQ is empty", async () => {
    const { client } = fakeSqsClient([{ ApproximateNumberOfMessages: "0" }]);
    const scheduler = new DlqMonitorScheduler(client, "wager-transactions-dlq.fifo", 10);

    try {
      scheduler.onApplicationBootstrap();
      await wait(60);

      expect(warnings).toEqual([]);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("onModuleDestroy stops scheduling further polls", async () => {
    const { client, getQueueAttributesCalls } = fakeSqsClient([
      { ApproximateNumberOfMessages: "0" },
    ]);
    const scheduler = new DlqMonitorScheduler(client, "wager-transactions-dlq.fifo", 10);

    scheduler.onApplicationBootstrap();
    await wait(30);
    const callsAtDestroy = getQueueAttributesCalls();
    expect(callsAtDestroy).toBeGreaterThanOrEqual(1);

    scheduler.onModuleDestroy();
    await wait(60);

    expect(getQueueAttributesCalls()).toBe(callsAtDestroy);
  });

  test("a poll cycle whose GetQueueAttributesCommand call rejects is logged as an error and does not stop the scheduler from polling again", async () => {
    const { client, getQueueAttributesCalls } = fakeSqsClient([
      new Error("simulated LocalStack outage"),
      { ApproximateNumberOfMessages: "0" },
    ]);
    const scheduler = new DlqMonitorScheduler(client, "wager-transactions-dlq.fifo", 10);

    try {
      scheduler.onApplicationBootstrap();
      await wait(60);

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(getQueueAttributesCalls()).toBeGreaterThanOrEqual(2);
    } finally {
      scheduler.onModuleDestroy();
    }
  });
});
