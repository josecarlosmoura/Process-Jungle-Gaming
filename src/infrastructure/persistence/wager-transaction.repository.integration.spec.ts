import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import { WagerTransaction } from "../../domain/wager-transaction";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "../database/mikro-orm.config";
import { WalletMikroOrmRepository } from "./wallet.repository";
import { WagerTransactionMikroOrmRepository } from "./wager-transaction.repository";

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

function makeWalletRepo() {
  return new WalletMikroOrmRepository(orm.em.fork());
}

function makeRepo() {
  return new WagerTransactionMikroOrmRepository(orm.em.fork());
}

async function seedWallet(): Promise<string> {
  const walletId = randomUUID();
  await makeWalletRepo().save(
    Wallet.open({ id: walletId, playerId: randomUUID(), initialBalance: Money.from({ amount: "500.00", currency: "BRL" }) }),
  );
  return walletId;
}

async function deleteTransaction(id: string): Promise<void> {
  await connection.execute("delete from wager_transactions where id = ?", [id]);
}

async function deleteWallet(id: string): Promise<void> {
  await connection.execute("delete from wallets where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("WagerTransactionMikroOrmRepository - round-trip", () => {
  test("save and findByIdempotencyKey round-trip every field exactly, including an absent referenceExternalTransactionId", async () => {
    const walletId = await seedWallet();
    const id = randomUUID();
    const idempotencyKey = `provider-x:${randomUUID()}`;
    try {
      const transaction = WagerTransaction.create({
        id,
        providerId: "provider-x",
        externalTransactionId: randomUUID(),
        idempotencyKey,
        payloadHash: "a".repeat(64),
        walletId,
        playerId: randomUUID(),
        roundId: randomUUID(),
        gameId: "slot-1",
        kind: "BET",
        money: Money.from({ amount: "25.50", currency: "BRL" }),
      });
      await makeRepo().save(transaction);

      const found = await makeRepo().findByIdempotencyKey(idempotencyKey);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
      expect(found?.providerId).toBe("provider-x");
      expect(found?.externalTransactionId).toBe(transaction.externalTransactionId);
      expect(found?.idempotencyKey).toBe(idempotencyKey);
      expect(found?.payloadHash).toBe("a".repeat(64));
      expect(found?.walletId).toBe(walletId);
      expect(found?.playerId).toBe(transaction.playerId);
      expect(found?.roundId).toBe(transaction.roundId);
      expect(found?.gameId).toBe("slot-1");
      expect(found?.kind).toBe("BET");
      expect(found?.money.toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
      expect(found?.referenceExternalTransactionId).toBeUndefined();
      expect(found?.status).toBe("PENDING");
      expect(found?.createdAt.getTime()).toBe(transaction.createdAt.getTime());
    } finally {
      await deleteTransaction(id);
      await deleteWallet(walletId);
    }
  });

  test("findByProviderAndExternalId returns the same transaction state", async () => {
    const walletId = await seedWallet();
    const id = randomUUID();
    const externalTransactionId = randomUUID();
    try {
      const transaction = WagerTransaction.create({
        id,
        providerId: "provider-y",
        externalTransactionId,
        idempotencyKey: `provider-y:${externalTransactionId}`,
        payloadHash: "b".repeat(64),
        walletId,
        playerId: randomUUID(),
        roundId: randomUUID(),
        gameId: "slot-2",
        kind: "WIN",
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        referenceExternalTransactionId: randomUUID(),
      });
      transaction.markProcessed(undefined, new Date());
      await makeRepo().save(transaction);

      const found = await makeRepo().findByProviderAndExternalId("provider-y", externalTransactionId);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(id);
      expect(found?.status).toBe("PROCESSED");
      expect(found?.referenceExternalTransactionId).toBe(transaction.referenceExternalTransactionId);
      expect(found?.processedAt?.getTime()).toBe(transaction.processedAt?.getTime());
    } finally {
      await deleteTransaction(id);
      await deleteWallet(walletId);
    }
  });
});
