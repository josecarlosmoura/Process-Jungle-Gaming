import { describe, expect, test } from "bun:test";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { INTEGRATION_EVENTS_QUEUE_NAME, WAGER_TRANSACTIONS_DLQ_NAME, WAGER_TRANSACTIONS_QUEUE_NAME } from "./queue-names";

const client = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

function runSetupScript(): void {
  const result = Bun.spawnSync(["bash", "scripts/setup-queues.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, SQS_ENDPOINT_URL: "http://localhost:4566", AWS_REGION: "us-east-1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`setup-queues.sh exited with code ${result.exitCode}: ${result.stderr.toString()}`);
  }
}

async function countQueuesNamed(name: string): Promise<number> {
  const response = await client.send(new ListQueuesCommand({ QueueNamePrefix: name }));
  return (response.QueueUrls ?? []).filter((url) => url.endsWith(`/${name}`)).length;
}

// o overhead do processo "aws" CLI (Python) por chamada do script fica em torno de 3s -
// acima do timeout padrao de 5000ms do bun:test, por isso cada teste aqui estende o proprio.
const SCRIPT_TEST_TIMEOUT_MS = 20_000;

describe("queue provisioning", () => {
  test(
    "provisioning the queues makes wager-transactions.fifo and wager-transactions-dlq.fifo listable via ListQueues",
    async () => {
      runSetupScript();

      const mainCount = await countQueuesNamed(WAGER_TRANSACTIONS_QUEUE_NAME);
      const dlqCount = await countQueuesNamed(WAGER_TRANSACTIONS_DLQ_NAME);

      expect(mainCount).toBe(1);
      expect(dlqCount).toBe(1);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "running the provisioning script a second time exits successfully and leaves exactly one queue per name, no duplicates",
    async () => {
      runSetupScript();
      runSetupScript();

      const mainCount = await countQueuesNamed(WAGER_TRANSACTIONS_QUEUE_NAME);
      const dlqCount = await countQueuesNamed(WAGER_TRANSACTIONS_DLQ_NAME);

      expect(mainCount).toBe(1);
      expect(dlqCount).toBe(1);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "the main queue RedrivePolicy deadLetterTargetArn points at the DLQ QueueArn",
    async () => {
      runSetupScript();

      const mainUrl = await client.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE_NAME }));
      const dlqUrl = await client.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_DLQ_NAME }));

      const mainAttributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: mainUrl.QueueUrl, AttributeNames: ["RedrivePolicy"] }),
      );
      const dlqAttributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl.QueueUrl, AttributeNames: ["QueueArn"] }),
      );

      const redrivePolicy = JSON.parse(mainAttributes.Attributes?.RedrivePolicy ?? "{}");

      expect(redrivePolicy.deadLetterTargetArn).toBe(dlqAttributes.Attributes?.QueueArn);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "running the provisioning script again after an attribute diverged out-of-band converges that attribute back, instead of failing with QueueAlreadyExists",
    async () => {
      runSetupScript();

      const mainUrl = await client.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE_NAME }));
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: mainUrl.QueueUrl,
          Attributes: { VisibilityTimeout: "45" },
        }),
      );

      runSetupScript();

      const attributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: mainUrl.QueueUrl, AttributeNames: ["VisibilityTimeout"] }),
      );

      expect(attributes.Attributes?.VisibilityTimeout).toBe("30");
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  test(
    "provisioning the queues makes integration-events.fifo listable via ListQueues as a FIFO queue",
    async () => {
      runSetupScript();

      const count = await countQueuesNamed(INTEGRATION_EVENTS_QUEUE_NAME);
      expect(count).toBe(1);

      const url = await client.send(new GetQueueUrlCommand({ QueueName: INTEGRATION_EVENTS_QUEUE_NAME }));
      const attributes = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: url.QueueUrl, AttributeNames: ["FifoQueue"] }),
      );
      expect(attributes.Attributes?.FifoQueue).toBe("true");
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );
});
