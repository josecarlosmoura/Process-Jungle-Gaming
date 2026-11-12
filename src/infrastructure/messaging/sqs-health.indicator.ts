import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { WAGER_TRANSACTIONS_QUEUE_NAME } from "./queue-names";

export const DEFAULT_TIMEOUT_MS = 2000;

@Injectable()
export class SqsHealthIndicator {
  constructor(private readonly sqsClient: SQSClient) {}

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("sqs health check timed out")), timeoutMs);
    });

    try {
      await Promise.race([
        this.sqsClient.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE_NAME })),
        timeout,
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
