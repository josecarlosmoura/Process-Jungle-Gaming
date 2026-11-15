import { Module } from "@nestjs/common";
import { AppConfigModule } from "./infrastructure/config/app-config.module";
import { DlqMonitorModule } from "./presentation/dlq-monitor/dlq-monitor.module";
import { DomainErrorHandlingModule } from "./presentation/common/domain-error-handling.module";
import { HealthModule } from "./presentation/health/health.module";
import { MetricsModule } from "./presentation/metrics/metrics.module";
import { OutboxPublisherModule } from "./presentation/outbox-publisher/outbox-publisher.module";
import { PendingReferenceReprocessorModule } from "./presentation/pending-reference-reprocessor/pending-reference-reprocessor.module";
import { SqsConsumerModule } from "./presentation/sqs-consumer/sqs-consumer.module";
import { WalletsModule } from "./presentation/wallets/wallets.module";
import { WageringModule } from "./presentation/wagering/wagering.module";

@Module({
  imports: [
    AppConfigModule,
    DomainErrorHandlingModule,
    HealthModule,
    MetricsModule,
    WalletsModule,
    WageringModule,
    OutboxPublisherModule,
    SqsConsumerModule,
    DlqMonitorModule,
    PendingReferenceReprocessorModule,
  ],
})
export class AppModule {}
