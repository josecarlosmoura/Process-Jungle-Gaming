import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { SqsModule } from "../../infrastructure/messaging/sqs-client.module";
import { DlqMonitorScheduler } from "./dlq-monitor.scheduler";

@Module({
  imports: [SqsModule, AppConfigModule],
  providers: [
    {
      provide: DlqMonitorScheduler,
      useFactory: (sqsClient: SQSClient, config: AppConfigService) =>
        new DlqMonitorScheduler(
          sqsClient,
          config.wagerTransactionsDlqName,
          config.dlqMonitorPollIntervalMs,
        ),
      inject: [SQSClient, AppConfigService],
    },
  ],
})
export class DlqMonitorModule {}
