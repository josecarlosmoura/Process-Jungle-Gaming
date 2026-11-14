import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { RequestContext } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";

// Mesmo padrao de src/application/use-cases/publish-outbox.use-case.integration.spec.ts (de onde
// este cenario foi generalizado para volume, com dois publishers concorrentes).
Object.assign(process.env, { DB_NAME: "wagering_test" });

const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { IntegrationEventSqsPublisher } = await import("../../src/infrastructure/messaging/integration-event-sqs-publisher");
const { INTEGRATION_EVENTS_QUEUE_NAME } = await import("../../src/infrastructure/messaging/queue-names");
const { OutboxMessageMikroOrmRepository } = await import("../../src/infrastructure/persistence/outbox-message.repository");
const { PublishOutboxUseCase } = await import("../../src/application/use-cases/publish-outbox.use-case");

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
runSetupScript();
const queueUrlResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: INTEGRATION_EVENTS_QUEUE_NAME }));
const queueUrl = queueUrlResult.QueueUrl as string;

function makeUseCase(batchSize: number): InstanceType<typeof PublishOutboxUseCase> {
  return new PublishOutboxUseCase(
    orm.em,
    new OutboxMessageMikroOrmRepository(orm.em),
    new IntegrationEventSqsPublisher(sqsClient),
    batchSize,
  );
}

async function insertPendingRow(id: string, aggregateId: string, marker: string): Promise<void> {
  await connection.execute(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
     values (?, ?, 'TestEvent', ?, now(), 0)`,
    [id, aggregateId, JSON.stringify({ marker })],
  );
}

async function countUnpublished(ids: string[]): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from outbox_messages where id in (${ids.map(() => "?").join(",")}) and published_at is null`,
    ids,
  );
  return Number(rows[0]?.count ?? 0);
}

async function deleteRows(ids: string[]): Promise<void> {
  await connection.execute(`delete from outbox_messages where id in (${ids.map(() => "?").join(",")})`, ids);
}

// Dois "loops de publisher" rodando ao mesmo tempo, cada um chamando execute() repetidamente
// (mesmo padrao de poll do OutboxPublisherScheduler real em produção, um ciclo apos o outro) até o
// chamador sinalizar parada - nunca uma unica chamada, que só reivindicaria um lote (batchSize) do
// total pendente via FOR UPDATE SKIP LOCKED.
async function runPublisherLoop(batchSize: number, stop: { requested: boolean }): Promise<void> {
  while (!stop.requested) {
    await RequestContext.create(orm.em, () => makeUseCase(batchSize).execute());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Recebe repetidamente da fila real, contando quantas vezes cada marcador do lote aparece -
// apagando cada ocorrencia encontrada. Outros arquivos de test/concurrency/ tambem sobem AppModule
// completo com OutboxPublisherScheduler real sobre esta MESMA fila compartilhada - rodadas
// "ruidosas" (so com mensagens de outros arquivos, zero dos nossos marcadores) sao esperadas e
// nunca contam como motivo para desistir. Para so quando (a) todo marcador do lote ja foi visto
// pelo menos uma vez E algumas rodadas extras de "dreno" (para pegar uma duplicata tardia) ja
// rodaram, ou (b) o deadline total esgota - nunca por um numero fixo/contador de rodadas vazias
// consecutivas, que um vizinho barulhento pode disparar antes da hora.
async function collectDeliveries(markers: ReadonlySet<string>, timeoutMs = 20_000, drainRoundsAfterComplete = 3): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const remaining = new Set(markers);
  const deadline = Date.now() + timeoutMs;
  let drainRounds = 0;
  while (Date.now() < deadline && (remaining.size > 0 || drainRounds < drainRoundsAfterComplete)) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    for (const sqsMessage of response.Messages ?? []) {
      const body = JSON.parse(sqsMessage.Body ?? "{}") as Record<string, unknown>;
      const marker = body.marker as string | undefined;
      if (marker && markers.has(marker)) {
        counts.set(marker, (counts.get(marker) ?? 0) + 1);
        remaining.delete(marker);
        await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: sqsMessage.ReceiptHandle }));
      }
      // mensagem de outro marcador/outra execucao - nunca apagada aqui, continua disponivel para
      // quem a espera de verdade.
    }
    if (remaining.size === 0) {
      drainRounds += 1;
    }
  }
  return counts;
}

afterAll(async () => {
  await orm.close();
});

describe("dois publishers concorrentes sobre a mesma outbox, em volume (100+ mensagens pendentes)", () => {
  beforeEach(async () => {
    // Outros specs *.integration.spec.ts publicam na mesma fila compartilhada enquanto a suite
    // inteira roda - purgar antes de cada teste garante que collectDeliveries so precisa achar as
    // mensagens deste proprio teste, mesmo raciocinio de
    // publish-outbox.use-case.integration.spec.ts.
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
  });

  test(
    "every one of 120 pending messages ends published_at not null exactly once, with no marker duplicated and none missing on the real queue",
    async () => {
      const ROW_COUNT = 120;
      const rows = Array.from({ length: ROW_COUNT }, () => ({
        id: randomUUID(),
        aggregateId: randomUUID(),
        marker: randomUUID(),
      }));
      const ids = rows.map((row) => row.id);
      try {
        await Promise.all(rows.map((row) => insertPendingRow(row.id, row.aggregateId, row.marker)));

        const stop = { requested: false };
        const loops = [runPublisherLoop(20, stop), runPublisherLoop(20, stop)];

        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline && (await countUnpublished(ids)) > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        stop.requested = true;
        await Promise.all(loops);

        expect(await countUnpublished(ids)).toBe(0);

        const deliveries = await collectDeliveries(new Set(rows.map((row) => row.marker)));
        for (const row of rows) {
          expect(deliveries.get(row.marker)).toBe(1);
        }
      } finally {
        await deleteRows(ids);
      }
    },
    60_000,
  );
});
