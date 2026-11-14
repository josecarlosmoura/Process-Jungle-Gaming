import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import { OutboxMessage } from "../../domain/outbox-message";
import { OutboxMessageEntity } from "./outbox-message.entity";

export function outboxEntityToDomain(entity: OutboxMessageEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload,
    occurredAt: entity.occurredAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    publishedAt: entity.publishedAt,
  });
}

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

  async claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    // LockMode.PESSIMISTIC_PARTIAL_WRITE -> driver Postgres do MikroORM gera
    // "FOR UPDATE SKIP LOCKED" (QueryBuilderHelper.js) - precisa rodar dentro de uma transação já
    // aberta pelo chamador; o lock dura até ela comitar/abortar.
    const entities = await this.em.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return entities.map(outboxEntityToDomain);
  }

  async updateDeliveryState(message: OutboxMessage): Promise<void> {
    // nativeUpdate roda na mesma transação/conexão do em ativo (não um novo round-trip fora do
    // lock mantido por claimPendingBatch) - nunca cria uma linha nova, só atualiza a já reivindicada.
    await this.em.nativeUpdate(OutboxMessageEntity, { id: message.id }, {
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
  }
}
