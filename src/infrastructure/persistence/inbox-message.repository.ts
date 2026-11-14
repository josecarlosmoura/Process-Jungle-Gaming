import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessageRepository } from "../../application/ports/inbox-message.repository";
import { InboxMessage } from "../../domain/inbox-message";
import { InboxMessageEntity } from "./inbox-message.entity";

export function inboxEntityToDomain(entity: InboxMessageEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: entity.messageId,
    consumerName: entity.consumerName,
    payloadHash: entity.payloadHash,
    receivedAt: entity.receivedAt,
    processedAt: entity.processedAt,
  });
}

@Injectable()
export class InboxMessageMikroOrmRepository implements InboxMessageRepository {
  constructor(private readonly em: EntityManager) {}

  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const entity = await this.em.findOne(InboxMessageEntity, { consumerName, messageId });
    return entity ? inboxEntityToDomain(entity) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt,
    });
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageEntity,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
