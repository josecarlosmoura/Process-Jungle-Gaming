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

// Dentro da suite completa, outras *.integration.spec.ts tambem abrem/fecham pools de conexao
// contra o mesmo Postgres/LocalStack - um unico execute() pode nao ganhar a corrida do lock
// (SKIP LOCKED legitimamente cede a linha para outro claim concorrente) ou so terminar de
// comitar um instante depois do nosso proprio read. "Publicado eventualmente" e exatamente o
// contrato real do worker (varias instancias, nunca uma garantia de latencia zero) - entao o
// teste espera por isso em vez de assumir que uma unica chamada basta.
async function waitForPublishedAt(id: string, timeoutMs = 8_000): Promise<Date> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await makeUseCase().execute();
    const publishedAt = await readPublishedAt(id);
    if (publishedAt) {
      return publishedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`outbox message ${id} was not published within ${timeoutMs}ms`);
}

// Varias mensagens de outras execucoes podem estar na fila (nunca ha consumer automatico nela
// ainda) - recebe repetidamente ate achar a que carrega o marcador desta chamada, ou o orcamento
// de tentativas esgota. Uma unica resposta vazia nunca e motivo para desistir: long polling
// (WaitTimeSeconds) nao garante que a mensagem ja esteja visivel na primeira rodada, sobretudo
// com o LocalStack sob a carga de uma suite inteira.
async function receiveByMarker(
  marker: string,
): Promise<{ body: Record<string, unknown>; attributes: Record<string, string | undefined> } | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
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
  }
  return null;
}

afterAll(async () => {
  await orm.close();
});

describe("PublishOutboxUseCase.execute - integração (Postgres + LocalStack reais)", () => {
  // Outros specs *.integration.spec.ts tambem bootam o AppModule completo (app.e2e.spec.ts,
  // health.ready*) e o proprio OutboxPublisherScheduler real deles pode publicar mensagens de
  // verdade nesta mesma fila compartilhada enquanto a suite inteira roda - um purge unico no
  // carregamento do arquivo nao e suficiente contra esse backlog acumulado entre um teste e o
  // outro. Purgar antes de CADA teste garante que receiveByMarker so precisa achar a mensagem
  // que o proprio teste publicou, nao vascular um backlog de tamanho imprevisivel.
  beforeEach(async () => {
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
  });


  test("execute publishes a pending message to SQS and marks published_at", async () => {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const marker = randomUUID();
    try {
      await insertPendingRow(id, aggregateId, marker);

      const publishedAt = await waitForPublishedAt(id);
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

      await waitForPublishedAt(id);

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

        const publishedAt = await waitForPublishedAt(id);
        expect(publishedAt).not.toBeNull();
        const received = await receiveByMarker(marker);
        expect(received).not.toBeNull();
      } finally {
        await deleteRow(id);
      }
    },
  );

  // Coleta, numa unica passagem limitada (poucas rodadas), quantas vezes cada marcador do
  // conjunto aparece na fila real - apaga cada ocorrencia encontrada (mesmo raciocinio de
  // receiveByMarker: mensagem de outro marcador nunca e apagada aqui). Ao contrario de chamar
  // receiveByMarker duas vezes por linha para "confirmar ausencia" (20 tentativas x 1s cada so
  // para provar negativo), esta unica varredura ja tabula perda (contagem 0) e duplicacao
  // (contagem >= 2) ao mesmo tempo, sem esperar um orcamento de tempo multiplicado pelo tamanho
  // do lote.
  async function collectDeliveries(markers: ReadonlySet<string>, rounds = 4): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let round = 0; round < rounds; round++) {
      const response = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
      );
      for (const sqsMessage of response.Messages ?? []) {
        const body = JSON.parse(sqsMessage.Body ?? "{}") as Record<string, unknown>;
        const marker = body.marker as string | undefined;
        if (marker && markers.has(marker)) {
          counts.set(marker, (counts.get(marker) ?? 0) + 1);
          await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: sqsMessage.ReceiptHandle }));
        }
      }
    }
    return counts;
  }

  test(
    "two concurrent PublishOutboxUseCase instances over the same pending batch publish each message exactly once",
    async () => {
      const rows = Array.from({ length: 6 }, () => ({
        id: randomUUID(),
        aggregateId: randomUUID(),
        marker: randomUUID(),
      }));
      try {
        await Promise.all(rows.map((row) => insertPendingRow(row.id, row.aggregateId, row.marker)));

        // RequestContext.create forka orm.em por chamada (mesmo mecanismo do
        // OutboxPublisherScheduler em produção, um ciclo por instância) - dá a cada chamada
        // concorrente sua própria conexão/transação real, disputando de verdade o mesmo lote
        // pendente via FOR UPDATE SKIP LOCKED (mesmo padrão de
        // reprocess-pending-reference.use-case.integration.spec.ts para duas instâncias reais).
        await Promise.all([
          RequestContext.create(orm.em, () => makeUseCase().execute()),
          RequestContext.create(orm.em, () => makeUseCase().execute()),
        ]);

        for (const row of rows) {
          expect(await waitForPublishedAt(row.id)).not.toBeNull();
        }

        const deliveries = await collectDeliveries(new Set(rows.map((row) => row.marker)));
        for (const row of rows) {
          expect(deliveries.get(row.marker)).toBe(1);
        }
      } finally {
        await Promise.all(rows.map((row) => deleteRow(row.id)));
      }
    },
    20_000,
  );
});
