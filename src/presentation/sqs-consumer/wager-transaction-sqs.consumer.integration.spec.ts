import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, PurgeQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Mesmo padrão de publish-outbox.use-case.integration.spec.ts - env setado antes do import
// dinâmico do módulo, nunca depois de um import estático no topo do arquivo.
Object.assign(process.env, {
  DB_HOST: "localhost",
  DB_PORT: "5440",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering_test",
  LOCALSTACK_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  LEDGER_CURSOR_SECRET: "dev-only-ledger-cursor-secret-not-for-production",
  // Curto de proposito - este teste espera por ausencia de efeito, nao quer esperar o default de
  // producao (10s) por ciclo de polling.
  SQS_CONSUMER_WAIT_TIME_SECONDS: "1",
});

const { SqsConsumerModule } = await import("./sqs-consumer.module");
const { WagerTransactionSqsConsumer } = await import("./wager-transaction-sqs.consumer");
const { WAGER_TRANSACTIONS_QUEUE_NAME } = await import("../../infrastructure/messaging/queue-names");
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");

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
const queueUrlResult = await sqsClient.send(new GetQueueUrlCommand({ QueueName: WAGER_TRANSACTIONS_QUEUE_NAME }));
const queueUrl = queueUrlResult.QueueUrl as string;

afterAll(async () => {
  await orm.close();
});

async function insertWallet(balanceAmount: string): Promise<string> {
  const id = randomUUID();
  await connection.execute(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values (?, ?, 'BRL', ?, 1, now(), now())`,
    [id, randomUUID(), balanceAmount],
  );
  return id;
}

async function deleteWalletCascade(walletId: string): Promise<void> {
  await connection.execute("delete from outbox_messages where aggregate_id = ?", [walletId]);
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
  await connection.execute("delete from wallets where id = ?", [walletId]);
}

async function deleteInboxRow(messageId: string): Promise<void> {
  await connection.execute("delete from inbox_messages where message_id = ?", [messageId]);
}

async function readWalletBalance(walletId: string): Promise<string> {
  const rows = await connection.execute<{ balance_amount: string }[]>(
    "select balance_amount from wallets where id = ?",
    [walletId],
  );
  return rows[0]?.balance_amount as string;
}

async function waitForBalance(walletId: string, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readWalletBalance(walletId)) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wallet ${walletId} balance never reached ${expected} within ${timeoutMs}ms`);
}

function wagerTransactionRequestedBody(messageId: string, walletId: string): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: `bet-sqs-${messageId}`,
      idempotencyKey: `provider-a:bet-sqs-${messageId}`,
      playerId: randomUUID(),
      walletId,
      roundId: "round-sqs-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    },
  });
}

describe("WagerTransactionSqsConsumer - integração (Postgres + LocalStack reais)", () => {
  beforeEach(async () => {
    // Outros specs tambem publicam/consomem esta fila compartilhada dentro da suite completa -
    // mesmo principio ja registrado em publish-outbox.use-case.integration.spec.ts.
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
  });

  test(
    "resending the same envelope messageId as a new SQS send does not debit the wallet twice",
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
      const consumer = moduleRef.get(WagerTransactionSqsConsumer);
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-${randomUUID()}`;

      try {
        consumer.onApplicationBootstrap();

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-1-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBody(businessMessageId, walletId),
          }),
        );
        await waitForBalance(walletId, "985.00");

        // Mesmo messageId de negocio, mas um MessageDeduplicationId diferente - SQS atribui um
        // Message.MessageId nativo novo a esta segunda entrega (prova do Landing door 1: a dedupe
        // e pelo messageId do envelope, nunca pelo nativo do SQS).
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-2-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBody(businessMessageId, walletId),
          }),
        );

        // Espera por ausencia de efeito: da tempo para varios ciclos de polling acontecerem
        // (WaitTimeSeconds=1, configurado no env deste arquivo) antes de confirmar que o saldo
        // nunca mudou de novo.
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        expect(await readWalletBalance(walletId)).toBe("985.00");
      } finally {
        await consumer.onModuleDestroy();
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await moduleRef.close();
      }
    },
    20_000,
  );
});
