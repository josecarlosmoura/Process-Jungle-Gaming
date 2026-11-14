import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Mesmo padrão de process-wager-transaction-outbox-atomicity.integration.spec.ts - env setado
// antes do import dinâmico do módulo, nunca depois de um import estático no topo do arquivo.
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
});

const { SqsConsumerModule } = await import("../../presentation/sqs-consumer/sqs-consumer.module");
const { ConsumeWagerTransactionMessageUseCase } = await import("./consume-wager-transaction-message.use-case");
const { WALLET_REPOSITORY_INTERFACE } = await import("../ports/wallet.repository");
const { WalletMikroOrmRepository } = await import("../../infrastructure/persistence/wallet.repository");
const { WAGER_TRANSACTIONS_CONSUMER_NAME } = await import("../../infrastructure/messaging/queue-names");
const { TransientInfrastructureError } = await import("../../domain/domain-error");
const { Money } = await import("../../domain/money");
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");
const { EntityManager } = await import("@mikro-orm/postgresql");

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

async function deleteWalletCascade(walletId: string | undefined): Promise<void> {
  if (!walletId) {
    return;
  }
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

async function readInboxRow(messageId: string): Promise<{ received_at: Date; processed_at: Date | null } | undefined> {
  const rows = await connection.execute<{ received_at: Date; processed_at: Date | null }[]>(
    "select received_at, processed_at from inbox_messages where consumer_name = ? and message_id = ?",
    [WAGER_TRANSACTIONS_CONSUMER_NAME, messageId],
  );
  return rows[0];
}

async function readWalletBalance(walletId: string): Promise<string> {
  const rows = await connection.execute<{ balance_amount: string }[]>(
    "select balance_amount from wallets where id = ?",
    [walletId],
  );
  return rows[0]?.balance_amount as string;
}

async function readWagerTransactionStatus(walletId: string, externalTransactionId: string): Promise<string | undefined> {
  const rows = await connection.execute<{ status: string }[]>(
    "select status from wager_transactions where wallet_id = ? and external_transaction_id = ?",
    [walletId, externalTransactionId],
  );
  return rows[0]?.status;
}

function betCommand(walletId: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `provider-a:${randomUUID()}`,
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    ...overrides,
  };
}

async function makeConsumeUseCase(): Promise<{
  useCase: InstanceType<typeof ConsumeWagerTransactionMessageUseCase>;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] }).compile();
  return {
    useCase: moduleRef.get(ConsumeWagerTransactionMessageUseCase),
    close: () => moduleRef.close(),
  };
}

// Simula uma falha de infraestrutura durante o lock pessimista da wallet - mesmo ponto de
// FailingOnSaveWalletRepository em process-wager-transaction-outbox-atomicity.integration.spec.ts,
// aqui parametrizado pelo erro para cobrir tanto TransientInfrastructureError quanto um erro
// desconhecido (nao-DomainError) com o mesmo mecanismo.
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

async function makeConsumeUseCaseFailingOn(error: Error): Promise<{
  useCase: InstanceType<typeof ConsumeWagerTransactionMessageUseCase>;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [SqsConsumerModule] })
    .overrideProvider(WALLET_REPOSITORY_INTERFACE)
    .useFactory({
      factory: (em: InstanceType<typeof EntityManager>) => new FailingOnFindWalletRepository(new WalletMikroOrmRepository(em), error),
      inject: [EntityManager],
    })
    .compile();
  return {
    useCase: moduleRef.get(ConsumeWagerTransactionMessageUseCase),
    close: () => moduleRef.close(),
  };
}

describe("ConsumeWagerTransactionMessageUseCase", () => {
  test("a new BET message debits the wallet and writes the same wager_transactions/wallet_ledger_entries/outbox_messages rows the HTTP endpoint would", async () => {
    const { useCase, close } = await makeConsumeUseCase();
    const walletId = await insertWallet("1000.00");
    const messageId = randomUUID();
    try {
      const result = await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId,
        payloadHash: `hash-${messageId}`,
        wagerTransactionCommand: betCommand(walletId),
      });

      expect(result.outcome).toBe("PROCESSED");
      expect(await readWalletBalance(walletId)).toBe("975.00");
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
      expect(await countWhere("outbox_messages", "aggregate_id", walletId)).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteInboxRow(messageId);
      await deleteWalletCascade(walletId);
      await close();
    }
  });

  test("a successfully processed message leaves an inbox row with processedAt filled alongside the financial effect", async () => {
    const { useCase, close } = await makeConsumeUseCase();
    const walletId = await insertWallet("1000.00");
    const messageId = randomUUID();
    try {
      await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId,
        payloadHash: `hash-${messageId}`,
        wagerTransactionCommand: betCommand(walletId),
      });

      const inboxRow = await readInboxRow(messageId);
      expect(inboxRow).toBeDefined();
      expect(inboxRow?.received_at).toBeTruthy();
      expect(inboxRow?.processed_at).toBeTruthy();
      expect(await readWalletBalance(walletId)).toBe("975.00");
    } finally {
      await deleteInboxRow(messageId);
      await deleteWalletCascade(walletId);
      await close();
    }
  });

  test("a REJECTED or PENDING_REFERENCE result is treated as successful processing", async () => {
    const { useCase, close } = await makeConsumeUseCase();
    const walletId = await insertWallet("10.00");
    const rejectedMessageId = randomUUID();
    const pendingReferenceMessageId = randomUUID();
    const rejectedExternalTransactionId = randomUUID();
    const pendingReferenceExternalTransactionId = randomUUID();
    try {
      const rejectedResult = await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId: rejectedMessageId,
        payloadHash: `hash-${rejectedMessageId}`,
        wagerTransactionCommand: betCommand(walletId, {
          externalTransactionId: rejectedExternalTransactionId,
          money: Money.from({ amount: "25.00", currency: "BRL" }),
        }),
      });
      expect(rejectedResult.outcome).toBe("PROCESSED");
      expect((await readInboxRow(rejectedMessageId))?.processed_at).toBeTruthy();
      expect(await readWagerTransactionStatus(walletId, rejectedExternalTransactionId)).toBe("REJECTED");

      const pendingResult = await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId: pendingReferenceMessageId,
        payloadHash: `hash-${pendingReferenceMessageId}`,
        wagerTransactionCommand: betCommand(walletId, {
          externalTransactionId: pendingReferenceExternalTransactionId,
          kind: "REFUND",
          money: Money.from({ amount: "5.00", currency: "BRL" }),
          referenceExternalTransactionId: `never-seen-${randomUUID()}`,
        }),
      });
      expect(pendingResult.outcome).toBe("PROCESSED");
      expect((await readInboxRow(pendingReferenceMessageId))?.processed_at).toBeTruthy();
      expect(await readWagerTransactionStatus(walletId, pendingReferenceExternalTransactionId)).toBe("PENDING_REFERENCE");
    } finally {
      await deleteInboxRow(rejectedMessageId);
      await deleteInboxRow(pendingReferenceMessageId);
      await deleteWalletCascade(walletId);
      await close();
    }
  });

  test("a message whose messageId is already processed resolves as DUPLICATE without reprocessing", async () => {
    const { useCase, close } = await makeConsumeUseCase();
    const walletId = await insertWallet("1000.00");
    const messageId = randomUUID();
    try {
      await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId,
        payloadHash: `hash-${messageId}`,
        wagerTransactionCommand: betCommand(walletId),
      });
      const balanceAfterFirst = await readWalletBalance(walletId);

      const duplicateResult = await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId,
        payloadHash: `hash-${messageId}`,
        wagerTransactionCommand: betCommand(walletId, { money: Money.from({ amount: "999.00", currency: "BRL" }) }),
      });

      expect(duplicateResult.outcome).toBe("DUPLICATE");
      expect(await readWalletBalance(walletId)).toBe(balanceAfterFirst);
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
    } finally {
      await deleteInboxRow(messageId);
      await deleteWalletCascade(walletId);
      await close();
    }
  });

  test("two concurrent executions with the same messageId process it exactly once, the loser resolving as DUPLICATE", async () => {
    const first = await makeConsumeUseCase();
    const second = await makeConsumeUseCase();
    const walletId = await insertWallet("1000.00");
    const messageId = randomUUID();
    try {
      const [resultA, resultB] = await Promise.all([
        first.useCase.execute({
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId,
          payloadHash: `hash-${messageId}`,
          wagerTransactionCommand: betCommand(walletId),
        }),
        second.useCase.execute({
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId,
          payloadHash: `hash-${messageId}`,
          wagerTransactionCommand: betCommand(walletId),
        }),
      ]);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["DUPLICATE", "PROCESSED"]);
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
      expect(await readWalletBalance(walletId)).toBe("975.00");
    } finally {
      await deleteInboxRow(messageId);
      await deleteWalletCascade(walletId);
      await first.close();
      await second.close();
    }
  });

  test("a transient or unknown error aborts the whole transaction, leaving no inbox row", async () => {
    const cases = [new TransientInfrastructureError("simulated lock timeout"), new Error("simulated unknown bug")];

    for (const error of cases) {
      const { useCase, close } = await makeConsumeUseCaseFailingOn(error);
      const walletId = await insertWallet("1000.00");
      const messageId = randomUUID();
      try {
        await expect(
          useCase.execute({
            consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
            messageId,
            payloadHash: `hash-${messageId}`,
            wagerTransactionCommand: betCommand(walletId),
          }),
        ).rejects.toThrow(error.message);

        expect(await readInboxRow(messageId)).toBeUndefined();
        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
      } finally {
        await deleteInboxRow(messageId);
        await deleteWalletCascade(walletId);
        await close();
      }
    }
  });

  test("a permanent DomainError is recorded as processed instead of propagating", async () => {
    const { useCase, close } = await makeConsumeUseCase();
    const nonExistentWalletId = randomUUID();
    const messageId = randomUUID();
    try {
      const result = await useCase.execute({
        consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
        messageId,
        payloadHash: `hash-${messageId}`,
        wagerTransactionCommand: betCommand(nonExistentWalletId),
      });

      expect(result.outcome).toBe("PROCESSED");
      expect((await readInboxRow(messageId))?.processed_at).toBeTruthy();
    } finally {
      await deleteInboxRow(messageId);
      await close();
    }
  });
});
