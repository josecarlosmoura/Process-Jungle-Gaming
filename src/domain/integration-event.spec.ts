import { describe, expect, test } from "bun:test";
import type { EventContext, IntegrationEventProps } from "./integration-event";
import { IntegrationEvent } from "./integration-event";

interface TestEventData {
  foo: string;
}

// Subclasse mínima só para exercitar o contrato comum - prova que qualquer subclasse concreta
// (WagerTransactionProcessed, WalletBalanceChanged, ...) herda o mesmo toJSON() sem reimplementá-lo
// (Liskov Substitution, ARCHITECTURE.md seção 1.2).
class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = "TestEvent";
  readonly version = 7;

  private constructor(props: IntegrationEventProps<TestEventData>) {
    super(props);
  }

  static from(aggregateId: string, data: TestEventData, ctx: EventContext): TestEvent {
    return new TestEvent({
      eventId: "event-1",
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    });
  }
}

describe("IntegrationEvent - toJSON envelope", () => {
  test("toJSON returns the full envelope with eventId, eventType, aggregateId, correlationId, occurredAt as ISO string, version and data", () => {
    const occurredAt = new Date("2026-01-01T00:00:00.000Z");
    const event = TestEvent.from("wallet-1", { foo: "bar" }, { correlationId: "correlation-1", causationId: "cause-1", occurredAt });

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "TestEvent",
      aggregateId: "wallet-1",
      correlationId: "correlation-1",
      causationId: "cause-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      version: 7,
      data: { foo: "bar" },
    });
  });

  test("toJSON omits causationId entirely when the event has none", () => {
    const event = TestEvent.from("wallet-1", { foo: "bar" }, { correlationId: "correlation-1", occurredAt: new Date() });

    const json = event.toJSON();

    expect(json).not.toHaveProperty("causationId");
    expect(Object.keys(json).sort()).toEqual(
      ["aggregateId", "correlationId", "data", "eventId", "eventType", "occurredAt", "version"].sort(),
    );
  });
});
