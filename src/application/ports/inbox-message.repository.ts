import type { InboxMessage } from "../../domain/inbox-message";

export const INBOX_MESSAGE_REPOSITORY_INTERFACE = Symbol("InboxMessageRepository");

export interface InboxMessageRepository {
  findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  // Insert-only - uma mensagem recebida nunca e regravada por insert, so por markProcessed. Pode
  // lancar UniqueConstraintViolationException numa corrida de duas instancias recebendo a mesma
  // mensagem (mesmo padrao de WagerTransaction.idempotencyKey).
  insert(message: InboxMessage): Promise<void>;
  // Persiste processedAt de uma mensagem ja inserida, na mesma transacao - nunca cria uma linha nova.
  markProcessed(message: InboxMessage): Promise<void>;
}
