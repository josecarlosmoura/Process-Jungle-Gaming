import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Mesmo padrão de wagering.e2e.spec.ts - env setado antes do import dinâmico do módulo, nunca
// depois de um import estático no topo do arquivo.
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

const { WageringModule } = await import("../../presentation/wagering/wagering.module");
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");
const { Money } = await import("../../domain/money");
const { WALLET_REPOSITORY_INTERFACE } = await import("../ports/wallet.repository");
const { WalletMikroOrmRepository } = await import("../../infrastructure/persistence/wallet.repository");
const { ProcessWagerTransactionUseCase } = await import("./process-wager-transaction.use-case");
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

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

// Delega toda leitura para a implementação real (precisa do lock pessimista de verdade para o
// caso de uso decidir o efeito), mas simula uma falha de infraestrutura exatamente no último save
// da transação - depois que o insert da outbox já rodou em código, ainda dentro da mesma
// transação SQL do em.transactional().
class FailingOnSaveWalletRepository {
  constructor(private readonly real: InstanceType<typeof WalletMikroOrmRepository>) {}

  findById(id: string) {
    return this.real.findById(id);
  }

  findByIdForUpdate(id: string) {
    return this.real.findByIdForUpdate(id);
  }

  findByPlayerAndCurrency(playerId: string, currency: string) {
    return this.real.findByPlayerAndCurrency(playerId, currency);
  }

  async save(): Promise<void> {
    throw new Error("simulated infrastructure failure");
  }
}

describe("ProcessWagerTransactionUseCase - atomicidade da outbox", () => {
  test("a wallet save failure after the outbox insert rolls back the transaction, the ledger entry and the outbox row together", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WageringModule] })
      .overrideProvider(WALLET_REPOSITORY_INTERFACE)
      .useFactory({
        factory: (em: InstanceType<typeof EntityManager>) => new FailingOnSaveWalletRepository(new WalletMikroOrmRepository(em)),
        inject: [EntityManager],
      })
      .compile();
    const useCase = moduleRef.get(ProcessWagerTransactionUseCase);

    const walletId = await insertWallet("1000.00");
    try {
      await expect(
        useCase.execute({
          idempotencyKey: `provider-a:${randomUUID()}`,
          providerId: "provider-a",
          externalTransactionId: randomUUID(),
          playerId: randomUUID(),
          walletId,
          roundId: "round-1",
          gameId: "fortune-chimp",
          kind: "BET",
          money: Money.from({ amount: "25.00", currency: "BRL" }),
        }),
      ).rejects.toThrow("simulated infrastructure failure");

      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);
      expect(await countWhere("outbox_messages", "aggregate_id", walletId)).toBe(0);

      const rows = await connection.execute<{ balance_amount: string; version: number }[]>(
        "select balance_amount, version from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("1000.00");
      expect(rows[0]?.version).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
      await moduleRef.close();
    }
  });
});
