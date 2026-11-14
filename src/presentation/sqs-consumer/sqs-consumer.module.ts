import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SqsModule } from "../../infrastructure/messaging/sqs-client.module";
import { InboxMessageMikroOrmRepository } from "../../infrastructure/persistence/inbox-message.repository";
import { INBOX_MESSAGE_REPOSITORY_INTERFACE } from "../../application/ports/inbox-message.repository";
import { ConsumeWagerTransactionMessageUseCase } from "../../application/use-cases/consume-wager-transaction-message.use-case";
// Fornece literalmente a mesma instancia de ProcessWagerTransactionUseCase usada pelo HTTP
// (CLAUDE.md: "reutilizando EXATAMENTE o mesmo use case") - este modulo nunca a reconstroi.
import { WageringModule } from "../wagering/wagering.module";
import { WagerTransactionSqsConsumer } from "./wager-transaction-sqs.consumer";

@Module({
  imports: [DatabaseModule, SqsModule, AppConfigModule, WageringModule],
  providers: [
    { provide: INBOX_MESSAGE_REPOSITORY_INTERFACE, useClass: InboxMessageMikroOrmRepository },
    ConsumeWagerTransactionMessageUseCase,
    {
      provide: WagerTransactionSqsConsumer,
      useFactory: (
        orm: MikroORM,
        sqsClient: SQSClient,
        useCase: ConsumeWagerTransactionMessageUseCase,
        config: AppConfigService,
      ) => new WagerTransactionSqsConsumer(orm, sqsClient, useCase, config.sqsConsumerWaitTimeSeconds),
      inject: [MikroORM, SQSClient, ConsumeWagerTransactionMessageUseCase, AppConfigService],
    },
  ],
})
export class SqsConsumerModule {}
