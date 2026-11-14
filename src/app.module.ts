import { Module } from "@nestjs/common";
import { AppConfigModule } from "./infrastructure/config/app-config.module";
import { DomainErrorHandlingModule } from "./presentation/common/domain-error-handling.module";
import { HealthModule } from "./presentation/health/health.module";
import { OutboxPublisherModule } from "./presentation/outbox-publisher/outbox-publisher.module";
import { SqsConsumerModule } from "./presentation/sqs-consumer/sqs-consumer.module";
import { WalletsModule } from "./presentation/wallets/wallets.module";
import { WageringModule } from "./presentation/wagering/wagering.module";

@Module({
  imports: [
    AppConfigModule,
    DomainErrorHandlingModule,
    HealthModule,
    WalletsModule,
    WageringModule,
    OutboxPublisherModule,
    SqsConsumerModule,
  ],
})
export class AppModule {}
