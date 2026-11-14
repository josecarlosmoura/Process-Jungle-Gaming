import { Inject, Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";
import type { IntegrationEventPublisher } from "../ports/integration-event-publisher";
import { INTEGRATION_EVENT_PUBLISHER_INTERFACE } from "../ports/integration-event-publisher";
import type { OutboxMessageRepository } from "../ports/outbox-message.repository";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../ports/outbox-message.repository";

@Injectable()
export class PublishOutboxUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(OUTBOX_MESSAGE_REPOSITORY_INTERFACE) private readonly outboxMessageRepository: OutboxMessageRepository,
    @Inject(INTEGRATION_EVENT_PUBLISHER_INTERFACE) private readonly publisher: IntegrationEventPublisher,
    private readonly batchSize: number,
  ) {}

  // O chamador (OutboxPublisherScheduler) e um loop de tempo, nunca uma requisicao HTTP - ele e
  // quem envolve cada chamada a este metodo em RequestContext.create(orm.em, ...), dando a
  // this.em (a instancia global injetada pelo Nest) um fork de contexto novo por ciclo. Sem
  // isso, this.em.transactional() ainda funcionaria, mas o identity map global cresceria para
  // sempre ao longo da vida do processo.
  async execute(): Promise<void> {
    // Uma unica transacao para o lote inteiro (nao uma por mensagem, decisao registrada em
    // plan.md/Assumptions) - claimPendingBatch so reivindica o lock FOR UPDATE SKIP LOCKED
    // enquanto esta transacao estiver aberta; markPublished/scheduleRetry de cada mensagem sao
    // persistidos antes do commit liberar os locks do lote inteiro.
    await this.em.transactional(async () => {
      const batch = await this.outboxMessageRepository.claimPendingBatch(new Date(), this.batchSize);
      for (const message of batch) {
        try {
          await this.publisher.publish(message);
          message.markPublished(new Date());
        } catch {
          // Uma falha de publicacao nunca aborta o lote inteiro - as demais mensagens ja
          // reivindicadas continuam sendo processadas; so esta entra em retry (RN-47, outbox
          // sem DLQ, retry infinito).
          message.scheduleRetry(new Date());
        }
        await this.outboxMessageRepository.updateDeliveryState(message);
      }
    });
  }
}
