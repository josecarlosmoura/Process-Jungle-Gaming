import type { OutboxMessage } from "../../domain/outbox-message";

export const OUTBOX_MESSAGE_REPOSITORY_INTERFACE = Symbol("OutboxMessageRepository");

export interface OutboxMessageRepository {
  save(message: OutboxMessage): Promise<void>;
}
