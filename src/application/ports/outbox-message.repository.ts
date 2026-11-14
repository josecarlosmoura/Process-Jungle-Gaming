import type { OutboxMessage } from "../../domain/outbox-message";

export const OUTBOX_MESSAGE_REPOSITORY_INTERFACE = Symbol("OutboxMessageRepository");

export interface OutboxMessageRepository {
  save(message: OutboxMessage): Promise<void>;
  // Reivindica (FOR UPDATE SKIP LOCKED) até `limit` mensagens pendentes - published_at IS NULL e
  // next_attempt_at já vencido ou nunca agendado - ordenadas por occurredAt. So pode ser chamado
  // dentro de uma transacao ja aberta: o lock so existe enquanto ela estiver em aberto.
  claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  // Persiste attempts/nextAttemptAt/publishedAt de uma mensagem ja reivindicada por
  // claimPendingBatch, na mesma transacao/lock - nunca cria uma linha nova.
  updateDeliveryState(message: OutboxMessage): Promise<void>;
}
