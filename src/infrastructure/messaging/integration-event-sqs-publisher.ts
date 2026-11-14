import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { IntegrationEventPublisher } from "../../application/ports/integration-event-publisher";
import type { OutboxMessage } from "../../domain/outbox-message";
import { INTEGRATION_EVENTS_QUEUE_NAME } from "./queue-names";

@Injectable()
export class IntegrationEventSqsPublisher implements IntegrationEventPublisher {
  // O nome da fila nunca muda durante o processo - memoiza a URL resolvida para nao pagar um
  // GetQueueUrlCommand extra a cada mensagem, em todo ciclo de polling.
  private queueUrlPromise?: Promise<string>;

  constructor(private readonly sqsClient: SQSClient) {}

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.resolveQueueUrl();
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  private resolveQueueUrl(): Promise<string> {
    if (!this.queueUrlPromise) {
      this.queueUrlPromise = this.sqsClient
        .send(new GetQueueUrlCommand({ QueueName: INTEGRATION_EVENTS_QUEUE_NAME }))
        .then((result) => {
          if (!result.QueueUrl) {
            throw new Error(`SQS did not return a QueueUrl for "${INTEGRATION_EVENTS_QUEUE_NAME}"`);
          }
          return result.QueueUrl;
        })
        .catch((error: unknown) => {
          // Uma resolucao que falhou nunca fica memoizada - a proxima publish() tenta de novo
          // (ex.: LocalStack ainda nao estava pronto no primeiro ciclo).
          this.queueUrlPromise = undefined;
          throw error;
        });
    }
    return this.queueUrlPromise;
  }
}
