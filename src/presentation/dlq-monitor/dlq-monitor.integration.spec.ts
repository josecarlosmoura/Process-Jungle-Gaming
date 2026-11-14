import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConsoleLogger, Logger } from "@nestjs/common";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DlqMonitorScheduler } from "./dlq-monitor.scheduler";

const client = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const dlqName = `dlq-monitor-test-${randomUUID()}.fifo`;
const created = await client.send(
  new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true" } }),
);
const queueUrl = created.QueueUrl as string;

afterAll(async () => {
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
});

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  Logger.overrideLogger({
    log: () => {},
    error: () => {},
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

describe("DlqMonitorScheduler - integração (LocalStack real)", () => {
  test("detects a message actually sitting in a real DLQ within one poll interval", async () => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: "dlq-monitor-test",
        MessageDeduplicationId: `dedup-${randomUUID()}`,
        MessageBody: "a message that landed in the DLQ and now requires manual audit",
      }),
    );

    const scheduler = new DlqMonitorScheduler(client, dlqName, 500);

    try {
      scheduler.onApplicationBootstrap();

      const deadline = Date.now() + 10_000;
      while (warnings.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain(dlqName);
    } finally {
      scheduler.onModuleDestroy();
    }
  }, 15_000);
});
