import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

// Adaptador fino de "gatilho = tempo", mesmo nivel de camada de Apresentacao que
// OutboxPublisherScheduler/WagerTransactionSqsConsumer (CLAUDE.md) - roda em toda instancia, sem
// eleicao de lider. So LE o atributo agregado da DLQ (GetQueueAttributesCommand) - nunca chama
// ReceiveMessageCommand/DeleteMessageCommand nela: um monitor que consumisse a DLQ sem apagar
// esconderia a mensagem (invisivel por VisibilityTimeout) de quem estiver fazendo auditoria
// manual via AWS CLI ao mesmo tempo (reprocessamento automatico da DLQ e fora de escopo).
@Injectable()
export class DlqMonitorScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DlqMonitorScheduler.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private queueUrlPromise?: Promise<string>;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueName: string,
    private readonly pollIntervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduleNextCycle(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNextCycle(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    // setTimeout recursivo, nunca setInterval - mesmo motivo de OutboxPublisherScheduler: um
    // ciclo so e reagendado depois que o anterior termina.
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      const count = await this.pollDlqMessageCount();
      if (count > 0) {
        this.logger.warn(
          `${count} mensagem(ns) detectada(s) em ${this.queueName} - requer auditoria manual`,
        );
      }
    } catch (error) {
      // Mesmo padrao de OutboxPublisherScheduler - um ciclo que falha (ex.: LocalStack fora do
      // ar) nunca derruba o worker, so loga e segue para o proximo ciclo.
      this.logger.error(
        "dlq monitor cycle failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.scheduleNextCycle(this.pollIntervalMs);
    }
  }

  private async pollDlqMessageCount(): Promise<number> {
    const queueUrl = await this.resolveQueueUrl();
    const result = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? "0");
  }

  private resolveQueueUrl(): Promise<string> {
    if (!this.queueUrlPromise) {
      this.queueUrlPromise = this.sqsClient
        .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
        .then((result) => {
          if (!result.QueueUrl) {
            throw new Error(`SQS did not return a QueueUrl for "${this.queueName}"`);
          }
          return result.QueueUrl;
        })
        .catch((error: unknown) => {
          this.queueUrlPromise = undefined;
          throw error;
        });
    }
    return this.queueUrlPromise;
  }
}
