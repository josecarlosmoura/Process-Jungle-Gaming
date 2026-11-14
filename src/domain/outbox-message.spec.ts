import { describe, expect, test } from "bun:test";
import type { EventContext, IntegrationEventProps } from "./integration-event";
import { IntegrationEvent } from "./integration-event";
import { OutboxMessage, OutboxMessageAlreadyPublishedError, type OutboxMessageState } from "./outbox-message";

interface TestEventData {
  foo: string;
}

class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = "TestEvent";
  readonly version = 3;

  private constructor(props: IntegrationEventProps<TestEventData>) {
    super(props);
  }

  static from(ctx: EventContext): TestEvent {
    return new TestEvent({
      eventId: "event-1",
      aggregateId: "wallet-1",
      correlationId: ctx.correlationId,
      occurredAt: ctx.occurredAt,
      data: { foo: "bar" },
    });
  }
}

describe("OutboxMessage.enqueue", () => {
  test("enqueue copies id, aggregateId, eventType, occurredAt from the event and starts attempts at 0 with nextAttemptAt and publishedAt undefined", () => {
    const occurredAt = new Date("2026-02-01T10:00:00.000Z");
    const event = TestEvent.from({ correlationId: "correlation-1", occurredAt });

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe("event-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("TestEvent");
    expect(message.occurredAt).toEqual(occurredAt);
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
  });
});

describe("OutboxMessage.rehydrate", () => {
  test("rehydrate reconstructs attempts, nextAttemptAt and publishedAt exactly when present", () => {
    const state: OutboxMessageState = {
      id: "message-1",
      aggregateId: "wallet-1",
      eventType: "TestEvent",
      payload: { foo: "bar" },
      occurredAt: new Date("2026-02-01T10:00:00.000Z"),
      attempts: 2,
      nextAttemptAt: new Date("2026-02-01T10:02:00.000Z"),
      publishedAt: new Date("2026-02-01T10:03:00.000Z"),
    };

    const message = OutboxMessage.rehydrate(state);

    expect(message.id).toBe(state.id);
    expect(message.aggregateId).toBe(state.aggregateId);
    expect(message.eventType).toBe(state.eventType);
    expect(message.payload).toEqual(state.payload);
    expect(message.occurredAt).toEqual(state.occurredAt);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(state.nextAttemptAt);
    expect(message.publishedAt).toEqual(state.publishedAt);
  });

  test("rehydrate reconstructs nextAttemptAt and publishedAt as undefined when absent", () => {
    const state: OutboxMessageState = {
      id: "message-1",
      aggregateId: "wallet-1",
      eventType: "TestEvent",
      payload: { foo: "bar" },
      occurredAt: new Date("2026-02-01T10:00:00.000Z"),
      attempts: 0,
    };

    const message = OutboxMessage.rehydrate(state);

    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
  });
});

function buildPendingMessage(): OutboxMessage {
  const occurredAt = new Date("2026-02-01T10:00:00.000Z");
  const event = TestEvent.from({ correlationId: "correlation-1", occurredAt });
  return OutboxMessage.enqueue(event);
}

describe("OutboxMessage.markPublished", () => {
  test("markPublished sets publishedAt to the given instant, leaving attempts and nextAttemptAt untouched", () => {
    const message = buildPendingMessage();
    const now = new Date("2026-02-01T10:00:05.000Z");

    message.markPublished(now);

    expect(message.publishedAt).toEqual(now);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
  });

  test("markPublished throws OutboxMessageAlreadyPublishedError when publishedAt is already set", () => {
    const message = buildPendingMessage();
    message.markPublished(new Date("2026-02-01T10:00:05.000Z"));

    expect(() => message.markPublished(new Date("2026-02-01T10:00:06.000Z"))).toThrow(
      OutboxMessageAlreadyPublishedError,
    );
  });
});

describe("OutboxMessage.scheduleRetry", () => {
  test("scheduleRetry increments attempts and schedules nextAttemptAt within the exponential-backoff bounds, capped at the max delay", () => {
    const message = buildPendingMessage();
    const now = new Date("2026-02-01T10:00:00.000Z");

    message.scheduleRetry(now);
    expect(message.attempts).toBe(1);
    const firstDelay = (message.nextAttemptAt as Date).getTime() - now.getTime();
    expect(firstDelay).toBeGreaterThanOrEqual(OutboxMessage.RETRY_BASE_DELAY_MS);
    expect(firstDelay).toBeLessThan(OutboxMessage.RETRY_BASE_DELAY_MS + OutboxMessage.RETRY_JITTER_MS);

    for (let i = 0; i < 9; i++) {
      message.scheduleRetry(now);
    }
    expect(message.attempts).toBe(10);
    const laterDelay = (message.nextAttemptAt as Date).getTime() - now.getTime();
    expect(laterDelay).toBeGreaterThan(firstDelay);
    expect(laterDelay).toBeLessThanOrEqual(OutboxMessage.RETRY_MAX_DELAY_MS + OutboxMessage.RETRY_JITTER_MS);
  });

  test("scheduleRetry throws when the message is already published", () => {
    const message = buildPendingMessage();
    message.markPublished(new Date("2026-02-01T10:00:05.000Z"));

    expect(() => message.scheduleRetry(new Date("2026-02-01T10:00:06.000Z"))).toThrow(
      OutboxMessageAlreadyPublishedError,
    );
  });
});
