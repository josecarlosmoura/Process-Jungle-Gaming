import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Fila FIFO descartavel, nome aleatorio - isola este teste de qualquer instancia real da app
// rodando ao lado (mesmo raciocinio de
// src/presentation/sqs-consumer/wager-transaction-sqs.consumer.integration.spec.ts).
const EPHEMERAL_QUEUE_NAME = `wager-transactions-crash-test-${randomUUID()}.fifo`;

// Mesmo padrao de test/concurrency/concurrent-bet.spec.ts - env setado antes do import dinamico de
// qualquer modulo, nunca depois de um import estatico no topo do arquivo.
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
  SQS_CONSUMER_WAIT_TIME_SECONDS: "1",
  WAGER_TRANSACTIONS_QUEUE_NAME: EPHEMERAL_QUEUE_NAME,
});

const { SqsConsumerModule } = await import("../../src/presentation/sqs-consumer/sqs-consumer.module");
const { WagerTransactionSqsConsumer } = await import("../../src/presentation/sqs-consumer/wager-transaction-sqs.consumer");
const { parseWagerTransactionRequestedEnvelope, toProcessWagerTransactionCommand } = await import(
  "../../src/presentation/sqs-consumer/wager-transaction-requested-envelope"
);
const { ConsumeWagerTransactionMessageUseCase } = await import(
  "../../src/application/use-cases/consume-wager-transaction-message.use-case"
);
const { WAGER_TRANSACTIONS_CONSUMER_NAME } = await import("../../src/infrastructure/messaging/queue-names");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

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

// VisibilityTimeout curto - a redelivery (passo 2 do cenario) precisa acontecer dentro do timeout
// do teste, mesmo raciocinio de wager-transaction-sqs.consumer.integration.spec.ts.
const createdQueue = await sqsClient.send(
  new CreateQueueCommand({ QueueName: EPHEMERAL_QUEUE_NAME, Attributes: { FifoQueue: "true", VisibilityTimeout: "2" } }),
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
  await connection.execute("delete from inbox_messages where consumer_name = ? and message_id = ?", [
    WAGER_TRANSACTIONS_CONSUMER_NAME,
    messageId,
  ]);
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

async function readWallet(walletId: string): Promise<{ balance_amount: string; currency: string }> {
  const rows = await connection.execute<{ balance_amount: string; currency: string }[]>(
    "select balance_amount, currency from wallets where id = ?",
    [walletId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  return row;
}

async function reconstructLedgerBalance(walletId: string, currency: string) {
  const rows = await connection.execute<{ direction: string; money_amount: string; money_currency: string }[]>(
    "select direction, money_amount, money_currency from wallet_ledger_entries where wallet_id = ?",
    [walletId],
  );
  return rows.reduce((balance, row) => {
    const entry = Money.from({ amount: row.money_amount, currency: row.money_currency });
    return row.direction === "CREDIT" ? balance.add(entry) : balance.subtract(entry);
  }, Money.zero(currency));
}

async function waitForBalance(walletId: string, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readWallet(walletId)).balance_amount === expected) {
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
      providerId: "provider-crash-before-ack",
      externalTransactionId: `bet-${messageId}`,
      idempotencyKey: `provider-crash-before-ack:bet-${messageId}`,
      playerId: randomUUID(),
      walletId,
      roundId: "round-crash-before-ack",
      gameId: "crash-before-ack-scenario",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    },
  });
}

const INITIAL_WALLET_BALANCE = "1000.00";

describe("worker morto depois do commit e antes do ack (fluxo SQS real)", () => {
  test(
    "a message whose financial effect was committed and confirmed by a direct DB query, but never acked, is redelivered once and resolved as already-processed by a new consumer instance, without duplicating the effect",
    async () => {
      const walletId = await insertWallet(INITIAL_WALLET_BALANCE);
      const businessMessageId = `biz-${randomUUID()}`;

      try {
        // Passo 1: simula o commit financeiro ja ter acontecido num processo que morreu antes de
        // confirmar (ack) a mensagem - chama o MESMO use case que o consumer chamaria, sem passar
        // pela fila ainda.
        const body = wagerTransactionRequestedBody(businessMessageId, walletId);
        const envelope = parseWagerTransactionRequestedEnvelope(body);
        const firstModuleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
        const useCase = firstModuleRef.get(ConsumeWagerTransactionMessageUseCase);
        await useCase.execute({
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId: businessMessageId,
          payloadHash: `hash-${businessMessageId}`,
          wagerTransactionCommand: toProcessWagerTransactionCommand(envelope),
        });
        await firstModuleRef.close();

        // Confirmacao explicita via query direta ao banco - nunca assumida - de que o commit de
        // fato ocorreu antes de simular o crash (ponto de atencao da propria tarefa: um teste que
        // mata o processo antes do commit de verdade estaria testando um cenario diferente).
        expect(await readWallet(walletId)).toEqual({ balance_amount: "985.00", currency: "BRL" });
        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
        expect(await countWhere("inbox_messages", "message_id", businessMessageId)).toBe(1);

        // Passo 2: a mensagem chega (ou volta a ficar visivel) na fila real - redelivery natural de
        // uma entrega cujo ack nunca aconteceu.
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: walletId,
            MessageDeduplicationId: `dedup-redelivery-${businessMessageId}`,
            MessageBody: body,
          }),
        );

        // Passo 3: "reinicio" - uma instancia NOVA do consumer (modulo/DI container proprios, nunca
        // a mesma instancia que processou o commit acima) consome a mensagem redelivered.
        const secondModuleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
        const secondConsumer = secondModuleRef.get(WagerTransactionSqsConsumer);
        try {
          secondConsumer.onApplicationBootstrap();
          await waitForBalance(walletId, "985.00");
          // Da tempo para o ack real (DeleteMessageCommand) acontecer depois do outcome DUPLICATE.
          await new Promise((resolve) => setTimeout(resolve, 1_000));

          const finalWallet = await readWallet(walletId);
          expect(finalWallet).toEqual({ balance_amount: "985.00", currency: "BRL" });
          expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
          expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);

          // Esta wallet nasceu por INSERT SQL direto (insertWallet), nunca pelo fluxo real de
          // POST /wallets - nao existe nenhum lancamento OPENING no ledger para o saldo inicial
          // semeado. A invariante correta aqui soma esse saldo inicial conhecido ao efeito liquido
          // reconstruido so dos lancamentos que de fato existem, nao reconstroi a partir de zero.
          const reconstructed = await reconstructLedgerBalance(walletId, finalWallet.currency);
          const expectedBalance = Money.from({ amount: INITIAL_WALLET_BALANCE, currency: finalWallet.currency }).add(
            reconstructed,
          );
          expect(expectedBalance.toJSON()).toEqual({ amount: finalWallet.balance_amount, currency: finalWallet.currency });
        } finally {
          await secondConsumer.onModuleDestroy();
          await secondModuleRef.close();
        }
      } finally {
        await deleteInboxRow(businessMessageId);
        await deleteWalletCascade(walletId);
      }
    },
    20_000,
  );
});
