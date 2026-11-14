import type { OutboxMessage } from "../../domain/outbox-message";

export const INTEGRATION_EVENT_PUBLISHER_INTERFACE = Symbol("IntegrationEventPublisher");

export interface IntegrationEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
