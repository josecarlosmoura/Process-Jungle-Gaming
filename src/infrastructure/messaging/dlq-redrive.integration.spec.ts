import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

// Par de filas efemero, valores pequenos (nunca os de producao - scripts/setup-queues.sh, 5
// tentativas x 30s = ~150s) - prova a MESMA forma de RedrivePolicy (maxReceiveCount +
// deadLetterTargetArn) sem o teste depender de ~150s de espera real. O valor de producao em si
// e provado separadamente por queue-provisioning.integration.spec.ts, lendo o atributo da fila
// real que o script provisiona.
const MAX_RECEIVE_COUNT = 2;
const VISIBILITY_TIMEOUT_SECONDS = 1;

const client = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const suffix = randomUUID();
const mainQueueName = `dlq-redrive-main-${suffix}.fifo`;
const dlqName = `dlq-redrive-dlq-${suffix}.fifo`;

const dlqCreated = await client.send(
  new CreateQueueCommand({
    QueueName: dlqName,
    Attributes: { FifoQueue: "true", VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS) },
  }),
);
const dlqUrl = dlqCreated.QueueUrl as string;
const dlqArn = (
  await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
  )
).Attributes?.QueueArn as string;

const redrivePolicy = JSON.stringify({
  deadLetterTargetArn: dlqArn,
  maxReceiveCount: MAX_RECEIVE_COUNT,
});
const mainCreated = await client.send(
  new CreateQueueCommand({
    QueueName: mainQueueName,
    Attributes: {
      FifoQueue: "true",
      VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: redrivePolicy,
    },
  }),
);
const mainUrl = mainCreated.QueueUrl as string;

afterAll(async () => {
  await client.send(new DeleteQueueCommand({ QueueUrl: mainUrl })).catch(() => {});
  await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })).catch(() => {});
});

async function receiveWithoutDeleting(queueUrl: string): Promise<boolean> {
  const result = await client.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }),
  );
  return (result.Messages ?? []).length > 0;
}

async function waitUntilMessageAppearsInDlq(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await receiveWithoutDeleting(dlqUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`message never appeared in ${dlqName} within ${timeoutMs}ms`);
}

describe("DLQ redrive (LocalStack real)", () => {
  test("a message that is never acknowledged on any delivery is redelivered exactly maxReceiveCount times then appears in the dead-letter queue", async () => {
    const dedupId = `dlq-redrive-${randomUUID()}`;
    await client.send(
      new SendMessageCommand({
        QueueUrl: mainUrl,
        MessageGroupId: "dlq-redrive-test",
        MessageDeduplicationId: dedupId,
        MessageBody: "payload that is never acked, simulating a persistent infrastructure failure",
      }),
    );

    let deliveries = 0;
    // VisibilityTimeout curto (1s) - cada rodada espera a visibilidade expirar antes da
    // proxima tentativa de ReceiveMessage; nunca deleta, simulando uma falha transitoria
    // persistente (o mesmo "sem DeleteMessageCommand" que WagerTransactionSqsConsumer produz
    // quando o use case lanca). Confirmado ao vivo contra o LocalStack real: o broker so
    // decide mover para a DLQ de forma lazy, na PROXIMA tentativa de ReceiveMessage depois de
    // maxReceiveCount entregas (a (maxReceiveCount+1)-esima tentativa volta vazia do lado da
    // fila principal) - por isso o loop continua tentando por mais algumas rodadas depois do
    // limite, em vez de parar exatamente nele.
    for (let attempt = 0; attempt < MAX_RECEIVE_COUNT + 3; attempt += 1) {
      const delivered = await receiveWithoutDeleting(mainUrl);
      if (delivered) {
        deliveries += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, (VISIBILITY_TIMEOUT_SECONDS + 1) * 1000));
    }

    expect(deliveries).toBe(MAX_RECEIVE_COUNT);
    await waitUntilMessageAppearsInDlq(10_000);

    const mainStillHasIt = await receiveWithoutDeleting(mainUrl);
    expect(mainStillHasIt).toBe(false);
  }, 30_000);
});
