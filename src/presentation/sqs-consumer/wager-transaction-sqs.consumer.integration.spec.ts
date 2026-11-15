import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Fila FIFO descartavel, nome aleatorio - nunca "wager-transactions.fifo" (a fila real). Isola
// este teste de qualquer instancia real da app rodando ao lado (ex.: `bun run start:dev`), que
// sempre consome a fila real por padrao e roubaria a mensagem antes deste teste conseguir -
// confirmado ao vivo: sem isso, o teste falha de forma instavel sempre que a app estiver no ar
// localmente (ver lição registrada em memória).
const EPHEMERAL_QUEUE_NAME = `wager-transactions-test-${randomUUID()}.fifo`;

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
  WAGER_TRANSACTIONS_QUEUE_NAME: EPHEMERAL_QUEUE_NAME,
});

const { SqsConsumerModule } = await import("./sqs-consumer.module");
const { WagerTransactionSqsConsumer } = await import("./wager-transaction-sqs.consumer");
const { parseWagerTransactionRequestedEnvelope, toProcessWagerTransactionCommand } = await import(
  "./wager-transaction-requested-envelope"
);
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");
const { ConsumeWagerTransactionMessageUseCase } = await import(
  "../../application/use-cases/consume-wager-transaction-message.use-case"
);
const { WALLET_REPOSITORY_INTERFACE } = await import("../../application/ports/wallet.repository");
const { WalletMikroOrmRepository } = await import("../../infrastructure/persistence/wallet.repository");
const { WAGER_TRANSACTIONS_CONSUMER_NAME } = await import("../../infrastructure/messaging/queue-names");
const { TransientInfrastructureError } = await import("../../domain/domain-error");
const { EntityManager } = await import("@mikro-orm/postgresql");
const { PinoLoggerService } = await import("../../infrastructure/observability/pino-logger.service");
const { MetricsService } = await import("../../infrastructure/observability/metrics.service");

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

// VisibilityTimeout curto (2s) - mesmo raciocinio de dlq-redrive.integration.spec.ts: os testes
// de falha forçada/redelivery (C2/C3) esperam a mensagem voltar a ficar visível, e o default de
// 30s tornaria isso lento sem nenhum ganho de cobertura.
const createdQueue = await sqsClient.send(
  new CreateQueueCommand({
    QueueName: EPHEMERAL_QUEUE_NAME,
    Attributes: { FifoQueue: "true", VisibilityTimeout: "2" },
  }),
);
const queueUrl = createdQueue.QueueUrl as string;

afterAll(async () => {
  await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
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

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

async function readInboxProcessedAt(messageId: string): Promise<Date | null> {
  const rows = await connection.execute<{ processed_at: Date | null }[]>(
    "select processed_at from inbox_messages where message_id = ?",
    [messageId],
  );
  return rows[0]?.processed_at ?? null;
}

// Mensagem ainda sentada na fila, nunca deletada - usado por C2 (falha forçada nunca ack) para
// confirmar diretamente contra o LocalStack real, sem depender do consumer sob teste (já parado
// nesse ponto) para observar o próprio estado da fila.
async function findQueuedMessage(businessMessageId: string): Promise<{ receiptHandle: string } | null> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 3 }),
  );
  for (const message of response.Messages ?? []) {
    const body = JSON.parse(message.Body ?? "{}") as { messageId?: string };
    if (body.messageId === businessMessageId && message.ReceiptHandle) {
      return { receiptHandle: message.ReceiptHandle };
    }
  }
  return null;
}

// Nunca usa ReceiveMessageCommand para esperar o dreno - um ReceiveMessageCommand (mesmo so para
// "conferir se ainda esta la") torna a mensagem invisivel pelo VisibilityTimeout da fila para
// QUALQUER consumidor, inclusive o consumer de verdade sob teste, disputando a propria mensagem
// que deveria deixar livre para ele processar (bug real observado: o teste ficava roubando a
// mensagem do consumer em loop e nunca convergia). GetQueueAttributesCommand le só a contagem
// agregada, sem tocar/travar nenhuma mensagem especifica.
async function waitUntilDrained(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const attributes = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    const visible = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? "0");
    const inFlight = Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0");
    if (visible === 0 && inFlight === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`queue never drained within ${timeoutMs}ms`);
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

// Mesmo mecanismo de consume-wager-transaction-message.use-case.integration.spec.ts
// (FailingOnFindWalletRepository) - aqui falhando no ponto do lock pessimista da wallet força o
// use case a lançar, o que faz o consumer NUNCA chamar deleteMessage() (wager-transaction-sqs.consumer.ts:158-167).
class FailingOnFindWalletRepository {
  constructor(
    private readonly real: InstanceType<typeof WalletMikroOrmRepository>,
    private readonly error: Error,
  ) {}

  findById(id: string) {
    return this.real.findById(id);
  }

  findByIdForUpdate(_id: string): Promise<never> {
    throw this.error;
  }

  findByPlayerAndCurrency(playerId: string, currency: string) {
    return this.real.findByPlayerAndCurrency(playerId, currency);
  }

  save(wallet: Parameters<InstanceType<typeof WalletMikroOrmRepository>["save"]>[0]) {
    return this.real.save(wallet);
  }
}

async function makeFailingConsumerModule(error: Error) {
  return Test.createTestingModule({ imports: [SqsConsumerModule] })
    .overrideProvider(WALLET_REPOSITORY_INTERFACE)
    .useFactory({
      factory: (em: InstanceType<typeof EntityManager>) => new FailingOnFindWalletRepository(new WalletMikroOrmRepository(em), error),
      inject: [EntityManager],
    })
    .compile();
}

describe("WagerTransactionSqsConsumer - integração (Postgres + LocalStack reais)", () => {
  test(
    "resending the same envelope messageId as a new SQS send does not debit the wallet twice",
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
      const consumer = moduleRef.get(WagerTransactionSqsConsumer);
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-${randomUUID()}`;
      MetricsService.resetForTesting();

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
        expect(await MetricsService.getMetricsText()).toContain('idempotency_duplicates_total{channel="inbox_sqs"} 1');
      } finally {
        await consumer.onModuleDestroy();
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await moduleRef.close();
      }
    },
    20_000,
  );

  test(
    "writes wallet, ledger, inbox and outbox rows together",
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
            MessageDeduplicationId: `dedup-c1-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBody(businessMessageId, walletId),
          }),
        );
        await waitForBalance(walletId, "985.00");

        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
        expect(await countWhere("outbox_messages", "aggregate_id", walletId)).toBeGreaterThanOrEqual(1);
        expect(await readInboxProcessedAt(businessMessageId)).toBeTruthy();
      } finally {
        await consumer.onModuleDestroy();
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await moduleRef.close();
      }
    },
    20_000,
  );

  test(
    "a forced infrastructure failure mid-flow leaves no wallet, ledger, inbox or outbox row, and keeps the message for redelivery",
    async () => {
      const moduleRef = await makeFailingConsumerModule(new TransientInfrastructureError("simulated lock timeout"));
      const consumer = moduleRef.get(WagerTransactionSqsConsumer);
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-${randomUUID()}`;

      try {
        consumer.onApplicationBootstrap();

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-c2-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBody(businessMessageId, walletId),
          }),
        );

        // Da tempo para pelo menos uma tentativa de polling receber e falhar (WaitTimeSeconds=1).
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await consumer.onModuleDestroy();

        expect(await readWalletBalance(walletId)).toBe("1000.00");
        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
        expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);
        expect(await countWhere("outbox_messages", "aggregate_id", walletId)).toBe(0);
        expect(await readInboxProcessedAt(businessMessageId)).toBeNull();

        // A mensagem nunca foi deletada da fila (deleteMessage so roda depois de execute()
        // resolver sem lancar) - continua la, visivel de novo apos o VisibilityTimeout curto
        // desta fila efemera, pronta para redelivery.
        const stillQueued = await findQueuedMessage(businessMessageId);
        expect(stillQueued).not.toBeNull();
        if (stillQueued) {
          await sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: stillQueued.receiptHandle }));
        }
      } finally {
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await moduleRef.close();
      }
    },
    20_000,
  );

  test(
    "a message whose financial effect was already committed by a process that died before ack is redelivered once and acknowledged without duplicating the effect, by a new consumer instance",
    async () => {
      const firstModuleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-${randomUUID()}`;

      try {
        // Simula o commit financeiro ja ter acontecido num processo anterior, que morreu antes
        // de confirmar (ack) a mensagem na fila - chama o MESMO use case que o consumer chamaria,
        // sem passar pela fila, deixando a mensagem original "pendente" para a redelivery abaixo.
        const body = wagerTransactionRequestedBody(businessMessageId, walletId);
        const envelope = parseWagerTransactionRequestedEnvelope(body);
        const useCase = firstModuleRef.get(ConsumeWagerTransactionMessageUseCase);
        await useCase.execute({
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId: businessMessageId,
          payloadHash: `hash-${businessMessageId}`,
          wagerTransactionCommand: toProcessWagerTransactionCommand(envelope),
        });
        expect(await readWalletBalance(walletId)).toBe("985.00");

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-c3-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBody(businessMessageId, walletId),
          }),
        );

        // "Reinicio": uma instancia NOVA do consumer (modulo/DI container proprios) consome a
        // mensagem ainda pendente na fila - nunca a mesma instancia/objeto que processou o
        // commit acima.
        const secondModuleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
        const secondConsumer = secondModuleRef.get(WagerTransactionSqsConsumer);
        try {
          secondConsumer.onApplicationBootstrap();
          await waitUntilDrained();

          expect(await readWalletBalance(walletId)).toBe("985.00");
          expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
          expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
        } finally {
          await secondConsumer.onModuleDestroy();
          await secondModuleRef.close();
        }
      } finally {
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await firstModuleRef.close();
      }
    },
    20_000,
  );
});

function captureLogLines(): { lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  Logger.overrideLogger(new PinoLoggerService(destination));
  return {
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
  };
}

function wagerTransactionRequestedBodyWithId(messageId: string, walletId: string, idSuffix: string): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: `bet-sqs-${idSuffix}`,
      idempotencyKey: `provider-a:bet-sqs-${idSuffix}`,
      playerId: randomUUID(),
      walletId,
      roundId: "round-sqs-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    },
  });
}

describe("WagerTransactionSqsConsumer - correlationId (Postgres + LocalStack reais)", () => {
  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  test(
    "a message with a correlationId MessageAttribute propagates it into the outcome log, together with messageId",
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
      const consumer = moduleRef.get(WagerTransactionSqsConsumer);
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-corr-${randomUUID()}`;
      // Depois de compile() de proposito - @nestjs/testing reseta o logger global ao compilar o
      // modulo (silencia logs de inicializacao), o que desfaria um override anterior.
      const { lines } = captureLogLines();

      try {
        consumer.onApplicationBootstrap();

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-corr-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBodyWithId(businessMessageId, walletId, businessMessageId),
            MessageAttributes: {
              correlationId: { DataType: "String", StringValue: "sqs-fixed-correlation-id" },
            },
          }),
        );
        await waitForBalance(walletId, "985.00");

        const outcome = lines().find(
          (line) => line.event === "wager_transaction_outcome" && line.correlationId === "sqs-fixed-correlation-id",
        );
        expect(outcome).toBeDefined();
        expect(outcome?.messageId).toBe(businessMessageId);
      } finally {
        await consumer.onModuleDestroy();
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
        await moduleRef.close();
      }
    },
    20_000,
  );

  test(
    "a message with no correlationId MessageAttribute still gets one generated, used consistently in the outcome log",
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
      const consumer = moduleRef.get(WagerTransactionSqsConsumer);
      const walletId = await insertWallet("1000.00");
      const businessMessageId = `biz-nocorr-${randomUUID()}`;
      const { lines } = captureLogLines();

      try {
        consumer.onApplicationBootstrap();

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-nocorr-${businessMessageId}`,
            MessageBody: wagerTransactionRequestedBodyWithId(businessMessageId, walletId, businessMessageId),
          }),
        );
        await waitForBalance(walletId, "985.00");

        const outcome = lines().find(
          (line) => line.event === "wager_transaction_outcome" && line.messageId === businessMessageId,
        );
        const correlationId = outcome?.correlationId as string | undefined;
        expect(typeof correlationId).toBe("string");
        expect(correlationId?.length ?? 0).toBeGreaterThan(0);
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
