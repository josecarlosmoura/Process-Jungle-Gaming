import { describe, expect, test } from "bun:test";
import { InboxMessage, InboxMessageAlreadyProcessedError } from "./inbox-message";

describe("InboxMessage", () => {
  test("markProcessed sets processedAt and isProcessed becomes true; calling it again throws", () => {
    const message = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-transaction-sqs-consumer",
      payloadHash: "hash-1",
      receivedAt: new Date("2026-11-14T10:00:00.000Z"),
    });
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();

    const processedAt = new Date("2026-11-14T10:00:01.000Z");
    message.markProcessed(processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(processedAt);
    expect(() => message.markProcessed(new Date())).toThrow(InboxMessageAlreadyProcessedError);
  });
});
