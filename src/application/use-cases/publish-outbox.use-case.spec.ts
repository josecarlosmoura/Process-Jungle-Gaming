import { describe, expect, test } from "bun:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { EventContext, IntegrationEventProps } from "../../domain/integration-event";
import { IntegrationEvent } from "../../domain/integration-event";
import { OutboxMessage } from "../../domain/outbox-message";
import type { IntegrationEventPublisher } from "../ports/integration-event-publisher";
import type { OutboxMessageRepository } from "../ports/outbox-message.repository";
import { PublishOutboxUseCase } from "./publish-outbox.use-case";

interface TestEventData {
  foo: string;
}

class TestEvent extends IntegrationEvent<TestEventData> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<TestEventData>) {
    super(props);
  }

  static from(id: string, ctx: EventContext): TestEvent {
    return new TestEvent({
      eventId: id,
      aggregateId: "wallet-1",
      correlationId: ctx.correlationId,
      occurredAt: ctx.occurredAt,
      data: { foo: "bar" },
    });
  }
}

function buildMessage(id: string): OutboxMessage {
  return OutboxMessage.enqueue(TestEvent.from(id, { correlationId: "c1", occurredAt: new Date() }));
}

// em.transactional so precisa invocar o callback dado - nenhum destes testes exercita
// atomicidade real (isso e o integration.spec, contra Postgres de verdade).
function fakeEntityManager(): EntityManager {
  return { transactional: (cb: (em: unknown) => unknown) => cb(undefined) } as unknown as EntityManager;
}

function fakeRepository(batch: OutboxMessage[]): OutboxMessageRepository & { updated: OutboxMessage[] } {
  const updated: OutboxMessage[] = [];
  return {
    updated,
    save: async () => {},
    claimPendingBatch: async () => batch,
    updateDeliveryState: async (message: OutboxMessage) => {
      updated.push(message);
    },
  };
}

describe("PublishOutboxUseCase.execute", () => {
  test("execute marks the successfully published messages and schedules a retry for the one that failed, without aborting the rest of the batch", async () => {
    const ok1 = buildMessage("event-1");
    const failing = buildMessage("event-2");
    const ok2 = buildMessage("event-3");
    const repository = fakeRepository([ok1, failing, ok2]);
    const publisher: IntegrationEventPublisher = {
      publish: async (message) => {
        if (message.id === failing.id) {
          throw new Error("simulated SQS failure");
        }
      },
    };

    const useCase = new PublishOutboxUseCase(fakeEntityManager(), repository, publisher, 10);
    await useCase.execute();

    expect(ok1.publishedAt).toBeDefined();
    expect(ok2.publishedAt).toBeDefined();
    expect(failing.publishedAt).toBeUndefined();
    expect(failing.attempts).toBe(1);
    expect(failing.nextAttemptAt).toBeDefined();
    expect(repository.updated.map((m) => m.id)).toEqual([ok1.id, failing.id, ok2.id]);
  });
});
