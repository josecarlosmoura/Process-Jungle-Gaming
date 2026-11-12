import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { AppConfigModule } from "../config/app-config.module";
import { AppConfigService } from "../config/app-config.service";
import { buildSqsClientConfig } from "./sqs-client.config";
import { SqsHealthIndicator } from "./sqs-health.indicator";

// As filas FIFO (MessageGroupId = walletId, ver ARCHITECTURE.md secao 2.2) dao ordenacao
// best-effort por wallet - nunca uma garantia de unicidade ou de exclusao mutua. Essa garantia
// real e o lock pessimista por walletId no Postgres; o SQSClient nunca e tratado como fonte
// de verdade de concorrencia pelo resto da aplicacao.
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: SQSClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new SQSClient(
          buildSqsClientConfig({
            localstackEndpoint: config.localstackEndpoint,
            awsRegion: config.awsRegion,
            awsAccessKeyId: config.awsAccessKeyId,
            awsSecretAccessKey: config.awsSecretAccessKey,
          }),
        ),
    },
    SqsHealthIndicator,
  ],
  exports: [SQSClient, SqsHealthIndicator],
})
export class SqsModule {}
