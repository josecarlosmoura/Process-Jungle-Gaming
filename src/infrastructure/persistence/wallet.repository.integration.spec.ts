import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "../database/mikro-orm.config";
import { WalletMikroOrmRepository } from "./wallet.repository";

// Forca wagering_test independente de como o teste e invocado (ex.: Test Explorer da IDE, que
// nao passa pelo script "test" do package.json, cujo "DB_NAME=wagering_test bun test" normalmente
// definiria essa env var) - nunca toca o banco de desenvolvimento (.env usa wagering_dev).
Object.assign(process.env, { DB_NAME: "wagering_test" });

const env = validateEnv(process.env);
const capturedSql: string[] = [];
const orm = await MikroORM.init({
  ...buildMikroOrmOptions({
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    dbName: env.DB_NAME,
  }),
  connect: true,
  debug: true,
  logger: (message: string) => capturedSql.push(message),
});
const connection = orm.em.getConnection();

function makeRepo() {
  return new WalletMikroOrmRepository(orm.em.fork());
}

async function readLocked(id: string): Promise<Wallet | null> {
  return orm.em.fork().transactional((em) => new WalletMikroOrmRepository(em).findByIdForUpdate(id));
}

async function deleteWallet(id: string): Promise<void> {
  await connection.execute("delete from wallets where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("WalletMikroOrmRepository - round-trip", () => {
  test("save and findByIdForUpdate round-trip Money with two exact decimal places", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      const wallet = Wallet.open({ id, playerId, initialBalance: Money.from({ amount: "1234.56", currency: "BRL" }) });
      await makeRepo().save(wallet);

      const found = await readLocked(id);

      expect(found).not.toBeNull();
      expect(found?.balance.toJSON()).toEqual({ amount: "1234.56", currency: "BRL" });
      expect(found?.playerId).toBe(playerId);
      expect(found?.version).toBe(1);
      expect(found?.createdAt.getTime()).toBe(wallet.createdAt.getTime());
      expect(found?.updatedAt.getTime()).toBe(wallet.updatedAt.getTime());
    } finally {
      await deleteWallet(id);
    }
  });

  test("save and findByIdForUpdate round-trip a round amount without dropping the trailing decimal zeros", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      const wallet = Wallet.open({ id, playerId, initialBalance: Money.from({ amount: "1000.00", currency: "BRL" }) });
      await makeRepo().save(wallet);

      const found = await readLocked(id);

      expect(found?.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    } finally {
      await deleteWallet(id);
    }
  });

  test("findByPlayerAndCurrency returns the same state as findByIdForUpdate", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      const wallet = Wallet.open({ id, playerId, initialBalance: Money.from({ amount: "42.10", currency: "BRL" }) });
      await makeRepo().save(wallet);

      const viaLock = await readLocked(id);
      const viaPlayer = await makeRepo().findByPlayerAndCurrency(playerId, "BRL");

      expect(viaPlayer).not.toBeNull();
      expect(viaPlayer?.id).toBe(id);
      expect(viaPlayer?.balance.toJSON()).toEqual(viaLock?.balance.toJSON());
      expect(viaPlayer?.version).toBe(viaLock?.version);
    } finally {
      await deleteWallet(id);
    }
  });

  test("findByIdForUpdate returns null for a wallet that does not exist", async () => {
    const result = await readLocked(randomUUID());
    expect(result).toBeNull();
  });

  test("findByPlayerAndCurrency returns null when no wallet matches", async () => {
    const result = await makeRepo().findByPlayerAndCurrency(randomUUID(), "BRL");
    expect(result).toBeNull();
  });
});

describe("WalletMikroOrmRepository - findById (leitura sem lock)", () => {
  test("findById issues a plain SELECT without FOR UPDATE", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      await makeRepo().save(Wallet.open({ id, playerId, initialBalance: Money.zero("BRL") }));

      capturedSql.length = 0;
      const found = await makeRepo().findById(id);

      expect(found?.id).toBe(id);
      expect(capturedSql.some((line) => /for update/i.test(line))).toBe(false);
    } finally {
      await deleteWallet(id);
    }
  });
});

describe("WalletMikroOrmRepository - lock pessimista", () => {
  test("findByIdForUpdate issues a SELECT ... FOR UPDATE", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      await makeRepo().save(Wallet.open({ id, playerId, initialBalance: Money.zero("BRL") }));

      capturedSql.length = 0;
      await readLocked(id);

      expect(capturedSql.some((line) => /for update/i.test(line))).toBe(true);
    } finally {
      await deleteWallet(id);
    }
  });

  test(
    "a second findByIdForUpdate on the same wallet blocks until the first transaction ends",
    async () => {
      const id = randomUUID();
      const playerId = randomUUID();
      try {
        await makeRepo().save(Wallet.open({ id, playerId, initialBalance: Money.zero("BRL") }));

        const start = Date.now();
        let secondResolvedAfterMs: number | null = null;

        const firstTx = orm.em.fork().transactional(async (em) => {
          await new WalletMikroOrmRepository(em).findByIdForUpdate(id);
          await new Promise((resolve) => setTimeout(resolve, 400));
        });

        // garante que a primeira transacao ja obteve o lock antes da segunda tentar
        await new Promise((resolve) => setTimeout(resolve, 80));

        const secondTx = orm.em.fork().transactional(async (em) => {
          await new WalletMikroOrmRepository(em).findByIdForUpdate(id);
          secondResolvedAfterMs = Date.now() - start;
        });

        await Promise.all([firstTx, secondTx]);

        expect(secondResolvedAfterMs).not.toBeNull();
        expect(secondResolvedAfterMs as number).toBeGreaterThanOrEqual(350);
      } finally {
        await deleteWallet(id);
      }
    },
    10_000,
  );

  test(
    "findByIdForUpdate on different wallets does not block each other",
    async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      try {
        await makeRepo().save(Wallet.open({ id: idA, playerId: randomUUID(), initialBalance: Money.zero("BRL") }));
        await makeRepo().save(Wallet.open({ id: idB, playerId: randomUUID(), initialBalance: Money.zero("BRL") }));

        const start = Date.now();
        let secondResolvedAfterMs: number | null = null;

        const firstTx = orm.em.fork().transactional(async (em) => {
          await new WalletMikroOrmRepository(em).findByIdForUpdate(idA);
          await new Promise((resolve) => setTimeout(resolve, 400));
        });

        await new Promise((resolve) => setTimeout(resolve, 80));

        const secondTx = orm.em.fork().transactional(async (em) => {
          await new WalletMikroOrmRepository(em).findByIdForUpdate(idB);
          secondResolvedAfterMs = Date.now() - start;
        });

        await Promise.all([firstTx, secondTx]);

        expect(secondResolvedAfterMs).not.toBeNull();
        expect(secondResolvedAfterMs as number).toBeLessThan(350);
      } finally {
        await deleteWallet(idA);
        await deleteWallet(idB);
      }
    },
    10_000,
  );
});

describe("WalletMikroOrmRepository - save() faz upsert", () => {
  test("a second save with the same id updates the same row, reflecting the latest balance and version", async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    try {
      const wallet = Wallet.open({ id, playerId, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
      await makeRepo().save(wallet);

      wallet.credit(Money.from({ amount: "50.00", currency: "BRL" }));
      await makeRepo().save(wallet);

      const rows = await connection.execute<{ count: string }[]>("select count(*) as count from wallets where id = ?", [id]);
      expect(Number(rows[0]?.count)).toBe(1);

      const found = await readLocked(id);
      expect(found?.balance.toJSON().amount).toBe("150.00");
      expect(found?.version).toBe(2);
    } finally {
      await deleteWallet(id);
    }
  });
});
