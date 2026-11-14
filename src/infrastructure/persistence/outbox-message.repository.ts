import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import type { OutboxMessage } from "../../domain/outbox-message";
import { OutboxMessageEntity } from "./outbox-message.entity";

export function outboxMessageToEntityData(
  message: OutboxMessage,
): Required<Pick<OutboxMessageEntity, "id" | "aggregateId" | "eventType" | "payload" | "occurredAt" | "attempts">> &
  Pick<OutboxMessageEntity, "nextAttemptAt" | "publishedAt"> {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload as Record<string, unknown>,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt,
  };
}

@Injectable()
export class OutboxMessageMikroOrmRepository implements OutboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    // Insert-only, mesmo padrão de WalletLedgerEntryMikroOrmRepository - uma mensagem da outbox
    // nunca é regravada, só inserida uma vez dentro da transação do efeito que a originou.
    await this.em.insert(OutboxMessageEntity, outboxMessageToEntityData(message));
  }
}
