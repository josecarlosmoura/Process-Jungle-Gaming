import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../../infrastructure/config/env.schema";
import { buildMikroOrmOptions } from "../../infrastructure/database/mikro-orm.config";
import { IntegrationEventSqsPublisher } from "../../infrastructure/messaging/integration-event-sqs-publisher";
import { INTEGRATION_EVENTS_QUEUE_NAME } from "../../infrastructure/messaging/queue-names";
import { OutboxMessageMikroOrmRepository } from "../../infrastructure/persistence/outbox-message.repository";
import { PublishOutboxUseCase } from "./publish-outbox.use-case";

// Forca wagering_test independente de como o teste e invocado - mesmo padrao dos demais
// *.integration.spec.ts.
Object.assign(process.env, { DB_NAME: "wagering_test" });

const env = validateEnv(process.env);
const orm = await MikroORM.init({
  ...buildMikroOrmOptions({
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    dbName: env.DB_NAME,
  }),
  connect: true,
});
const connection = orm.em.getConnection();

const sqsClient = new SQSClient({
  endpoint: env.LOCALSTACK_ENDPOINT,
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});

function runSetupScript(): void {
  const result = Bun.spawnSync(["bash", "scripts/setup-queues.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, SQS_ENDPOINT_URL: env.LOCALSTACK_ENDPOINT, AWS_REGION: env.AWS_REGION },
  });
  if (result.exitCode !== 0) {
    throw new Error(`setup-queues.sh exited with code ${result.exitCode}: ${result.stderr.toString()}`);
  }
}
// garante que integration-events.fifo existe independente da ordem de execucao dos arquivos de
// teste.
runSetupScript();
const queueUrlResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: INTEGRATION_EVENTS_QUEUE_NAME }));
const queueUrl = queueUrlResult.QueueUrl as string;
// Toda execucao anterior da suite (inclusive de outras tarefas, antes deste worker existir)
// deixou mensagens reais nesta fila - sem isto, receiveByMarker precisaria vascular um backlog
// sem limite para achar a mensagem desta execucao. Seguro: fila exclusiva de teste (LocalStack).
await sqsClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});

// em.transactional() so propaga a transacao via AsyncLocalStorage para outros consumidores do
// MESMO em quando chamado sobre o em "global" (orm.em) - exatamente o que a injecao de
// dependencia do Nest compartilha entre o caso de uso e o repositorio em producao (mesmo
// EntityManager injetado nos dois construtores). Um .fork() novo por chamada quebra essa
// propagacao (o repositorio nao veria a transacao aberta pelo caso de uso).
function makeUseCase(): PublishOutboxUseCase {
  return new PublishOutboxUseCase(
    orm.em,
    new OutboxMessageMikroOrmRepository(orm.em),
    new IntegrationEventSqsPublisher(sqsClient),
    10,
  );
}

async function insertPendingRow(id: string, aggregateId: string, marker: string): Promise<void> {
  await connection.execute(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
     values (?, ?, 'TestEvent', ?, now(), 0)`,
    [id, aggregateId, JSON.stringify({ marker })],
  );
}

async function readPublishedAt(id: string): Promise<Date | null> {
  const rows = await connection.execute<{ published_at: Date | null }[]>(
    "select published_at from outbox_messages where id = ?",
    [id],
  );
  return rows[0]?.published_at ?? null;
}

async function deleteRow(id: string): Promise<void> {
  await connection.execute("delete from outbox_messages where id = ?", [id]);
}

// Varias mensagens de outras execucoes podem estar na fila (nunca ha consumer automatico nela
// ainda) - recebe repetidamente ate achar a que carrega o marcador desta chamada, ou desiste.
async function receiveByMarker(
  marker: string,
): Promise<{ body: Record<string, unknown>; attributes: Record<string, string | undefined> } | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
      }),
    );
    for (const sqsMessage of response.Messages ?? []) {
      const body = JSON.parse(sqsMessage.Body ?? "{}") as Record<string, unknown>;
      if (body.marker === marker) {
        await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: sqsMessage.ReceiptHandle }));
        return { body, attributes: sqsMessage.Attributes ?? {} };
      }
      // mensagem de outra execucao/grupo - nunca apagada aqui; so volta a ficar visivel depois
      // do VisibilityTimeout da fila, sem interferir em quem a espera de verdade.
    }
    if ((response.Messages ?? []).length === 0) {
      break;
    }
  }
  return null;
}

afterAll(async () => {
  await orm.close();
});

describe("PublishOutboxUseCase.execute - integração (Postgres + LocalStack reais)", () => {
  test("execute publishes a pending message to SQS and marks published_at", async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const marker = randomUUID();
    try {
      await insertPendingRow(id, aggregateId, marker);

      await makeUseCase().execute();

      const publishedAt = await readPublishedAt(id);
      expect(publishedAt).not.toBeNull();

      const received = await receiveByMarker(marker);
      expect(received).not.toBeNull();
      expect(received?.body.marker).toBe(marker);
    } finally {
      await deleteRow(id);
    }
  });

  test("a published message carries MessageGroupId equal to aggregateId and MessageDeduplicationId equal to id", async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const marker = randomUUID();
    try {
      await insertPendingRow(id, aggregateId, marker);

      await makeUseCase().execute();

      const received = await receiveByMarker(marker);
      expect(received).not.toBeNull();
      expect(received?.attributes.MessageGroupId).toBe(aggregateId);
      expect(received?.attributes.MessageDeduplicationId).toBe(id);
    } finally {
      await deleteRow(id);
    }
  });

  test(
    "a message inserted directly via SQL, simulating a commit without publication, is published on the next execute cycle",
    async () => {
      // "Cenario obrigatorio" da propria T209: o commit da transacao financeira ja aconteceu
      // (linha existe, published_at/next_attempt_at NULL, attempts 0) - simula o processo ter
      // morrido antes de publicar. Nenhuma outra acao da aplicacao alem de execute() roda aqui.
      const id = randomUUID();
      const aggregateId = randomUUID();
      const marker = randomUUID();
      try {
        await insertPendingRow(id, aggregateId, marker);

        await makeUseCase().execute();

        const publishedAt = await readPublishedAt(id);
        expect(publishedAt).not.toBeNull();
        const received = await receiveByMarker(marker);
        expect(received).not.toBeNull();
      } finally {
        await deleteRow(id);
      }
    },
  );
});
