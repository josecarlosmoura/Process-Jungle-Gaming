import { Module } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SqsModule } from "../../infrastructure/messaging/sqs-client.module";
import { IntegrationEventSqsPublisher } from "../../infrastructure/messaging/integration-event-sqs-publisher";
import { OutboxMessageMikroOrmRepository } from "../../infrastructure/persistence/outbox-message.repository";
import { INTEGRATION_EVENT_PUBLISHER_INTERFACE } from "../../application/ports/integration-event-publisher";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../../application/ports/outbox-message.repository";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import type { IntegrationEventPublisher } from "../../application/ports/integration-event-publisher";
import { PublishOutboxUseCase } from "../../application/use-cases/publish-outbox.use-case";
import { OutboxPublisherScheduler } from "./outbox-publisher.scheduler";

@Module({
  imports: [DatabaseModule, SqsModule, AppConfigModule],
  providers: [
    { provide: OUTBOX_MESSAGE_REPOSITORY_INTERFACE, useClass: OutboxMessageMikroOrmRepository },
    { provide: INTEGRATION_EVENT_PUBLISHER_INTERFACE, useClass: IntegrationEventSqsPublisher },
    {
      provide: PublishOutboxUseCase,
      useFactory: (
        em: EntityManager,
        repository: OutboxMessageRepository,
        publisher: IntegrationEventPublisher,
        config: AppConfigService,
      ) => new PublishOutboxUseCase(em, repository, publisher, config.outboxPublisherBatchSize),
      inject: [EntityManager, OUTBOX_MESSAGE_REPOSITORY_INTERFACE, INTEGRATION_EVENT_PUBLISHER_INTERFACE, AppConfigService],
    },
    {
      provide: OutboxPublisherScheduler,
      useFactory: (orm: MikroORM, useCase: PublishOutboxUseCase, config: AppConfigService) =>
        new OutboxPublisherScheduler(orm, useCase, config.outboxPublisherPollIntervalMs),
      inject: [MikroORM, PublishOutboxUseCase, AppConfigService],
    },
  ],
})
export class OutboxPublisherModule {}
