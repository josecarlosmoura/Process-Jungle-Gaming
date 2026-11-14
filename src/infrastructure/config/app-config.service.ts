import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ConfigService } from "@nestjs/config";
import type { EnvSchema } from "./env.schema";

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvSchema, true>) {}

  get dbHost(): string {
    return this.configService.get("DB_HOST", { infer: true });
  }

  get dbPort(): number {
    return this.configService.get("DB_PORT", { infer: true });
  }

  get dbUser(): string {
    return this.configService.get("DB_USER", { infer: true });
  }

  get dbPassword(): string {
    return this.configService.get("DB_PASSWORD", { infer: true });
  }

  get dbName(): string {
    return this.configService.get("DB_NAME", { infer: true });
  }

  get localstackEndpoint(): string {
    return this.configService.get("LOCALSTACK_ENDPOINT", { infer: true });
  }

  get awsRegion(): string {
    return this.configService.get("AWS_REGION", { infer: true });
  }

  get awsAccessKeyId(): string {
    return this.configService.get("AWS_ACCESS_KEY_ID", { infer: true });
  }

  get awsSecretAccessKey(): string {
    return this.configService.get("AWS_SECRET_ACCESS_KEY", { infer: true });
  }

  get port(): number {
    return this.configService.get("PORT", { infer: true });
  }

  get nodeEnv(): EnvSchema["NODE_ENV"] {
    return this.configService.get("NODE_ENV", { infer: true });
  }

  get ledgerCursorSecret(): string {
    return this.configService.get("LEDGER_CURSOR_SECRET", { infer: true });
  }

  get outboxPublisherPollIntervalMs(): number {
    return this.configService.get("OUTBOX_PUBLISHER_POLL_INTERVAL_MS", { infer: true });
  }

  get outboxPublisherBatchSize(): number {
    return this.configService.get("OUTBOX_PUBLISHER_BATCH_SIZE", { infer: true });
  }

  get sqsConsumerWaitTimeSeconds(): number {
    return this.configService.get("SQS_CONSUMER_WAIT_TIME_SECONDS", { infer: true });
  }

  get wagerTransactionsQueueName(): string {
    return this.configService.get("WAGER_TRANSACTIONS_QUEUE_NAME", { infer: true });
  }

  get dlqMonitorPollIntervalMs(): number {
    return this.configService.get("DLQ_MONITOR_POLL_INTERVAL_MS", { infer: true });
  }

  get wagerTransactionsDlqName(): string {
    return this.configService.get("WAGER_TRANSACTIONS_DLQ_NAME", { infer: true });
  }

  get pendingReferenceReprocessorPollIntervalMs(): number {
    return this.configService.get("PENDING_REFERENCE_REPROCESSOR_POLL_INTERVAL_MS", { infer: true });
  }

  get pendingReferenceReprocessorBatchSize(): number {
    return this.configService.get("PENDING_REFERENCE_REPROCESSOR_BATCH_SIZE", { infer: true });
  }
}
