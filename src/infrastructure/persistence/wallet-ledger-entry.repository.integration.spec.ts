import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { encodeLedgerCursor, InvalidLedgerCursorError } from "../../application/ports/wallet-ledger-entry.repository";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import { WagerTransaction } from "../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "../database/mikro-orm.config";
import { WalletMikroOrmRepository } from "./wallet.repository";
import { WagerTransactionMikroOrmRepository } from "./wager-transaction.repository";
import { WalletLedgerEntryMikroOrmRepository } from "./wallet-ledger-entry.repository";

// Forca wagering_test independente de como o teste e invocado (ex.: Test Explorer da IDE, que
// nao passa pelo script "test" do package.json, cujo "DB_NAME=wagering_test bun test" normalmente
// definiria essa env var) - nunca toca o banco de desenvolvimento (.env usa wagering_dev).
Object.assign(process.env, { DB_NAME: "wagering_test" });

const env = validateEnv(process.env);
const cursorSecret = env.LEDGER_CURSOR_SECRET;
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

function makeRepo(secret: string = cursorSecret) {
  return new WalletLedgerEntryMikroOrmRepository(orm.em.fork(), secret);
}

async function seedWallet(): Promise<string> {
  const walletId = randomUUID();
  await new WalletMikroOrmRepository(orm.em.fork()).save(
    Wallet.open({ id: walletId, playerId: randomUUID(), initialBalance: Money.from({ amount: "500.00", currency: "BRL" }) }),
  );
  return walletId;
}

async function seedTransaction(walletId: string): Promise<string> {
  const transactionId = randomUUID();
  const transaction = WagerTransaction.create({
    id: transactionId,
    providerId: "provider-z",
    externalTransactionId: randomUUID(),
    idempotencyKey: `provider-z:${randomUUID()}`,
    payloadHash: "c".repeat(64),
    walletId,
    playerId: randomUUID(),
    roundId: randomUUID(),
    gameId: "slot-3",
    kind: "BET",
    money: Money.from({ amount: "10.00", currency: "BRL" }),
  });
  await new WagerTransactionMikroOrmRepository(orm.em.fork()).save(transaction);
  return transactionId;
}

async function deleteLedgerEntries(walletId: string): Promise<void> {
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
}

async function deleteTransactions(walletId: string): Promise<void> {
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
}

async function deleteWallet(id: string): Promise<void> {
  await connection.execute("delete from wallets where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("WalletLedgerEntryMikroOrmRepository - round-trip", () => {
  test("save and findByWalletId round-trip money, balanceBefore and balanceAfter exactly", async () => {
    const walletId = await seedWallet();
    const transactionId = await seedTransaction(walletId);
    try {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: "DEBIT",
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "500.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "490.00", currency: "BRL" }),
      });
      await makeRepo().save(entry);

      const [found] = await makeRepo().findByWalletId(walletId, { limit: 10 });

      expect(found).toBeDefined();
      expect(found?.id).toBe(entry.id);
      expect(found?.direction).toBe("DEBIT");
      expect(found?.money.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
      expect(found?.balanceBefore.toJSON()).toEqual({ amount: "500.00", currency: "BRL" });
      expect(found?.balanceAfter.toJSON()).toEqual({ amount: "490.00", currency: "BRL" });
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });
});

describe("WalletLedgerEntryMikroOrmRepository - findByTransactionId", () => {
  test("findByTransactionId returns the entry matching that transaction", async () => {
    const walletId = await seedWallet();
    const transactionId = await seedTransaction(walletId);
    try {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: "DEBIT",
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "500.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "490.00", currency: "BRL" }),
      });
      await makeRepo().save(entry);

      const found = await makeRepo().findByTransactionId(transactionId);

      expect(found?.id).toBe(entry.id);
      expect(found?.balanceAfter.toJSON()).toEqual({ amount: "490.00", currency: "BRL" });
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });

  test("findByTransactionId returns null when no entry matches", async () => {
    const found = await makeRepo().findByTransactionId(randomUUID());
    expect(found).toBeNull();
  });
});

describe("WalletLedgerEntryMikroOrmRepository - save() e insert-only", () => {
  test("a second save with the same id rejects with a unique constraint violation", async () => {
    const walletId = await seedWallet();
    const transactionId = await seedTransaction(walletId);
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId,
      transactionId,
      direction: "DEBIT",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "500.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "490.00", currency: "BRL" }),
    });
    try {
      await makeRepo().save(entry);

      await expect(makeRepo().save(entry)).rejects.toMatchObject({ code: "23505" });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wallet_ledger_entries where id = ?",
        [entry.id],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });
});

describe("WalletLedgerEntryMikroOrmRepository - paginação por cursor", () => {
  test("findByWalletId with limit 2 returns the two oldest entries ordered by createdAt ascending", async () => {
    const walletId = await seedWallet();
    const transactionIds = [await seedTransaction(walletId), await seedTransaction(walletId), await seedTransaction(walletId)];
    try {
      const entries: WalletLedgerEntry[] = [];
      let balance = Money.from({ amount: "500.00", currency: "BRL" });
      for (const transactionId of transactionIds) {
        const debit = Money.from({ amount: "10.00", currency: "BRL" });
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId,
          direction: "DEBIT",
          money: debit,
          balanceBefore: balance,
          balanceAfter: balance.subtract(debit),
        });
        balance = balance.subtract(debit);
        await makeRepo().save(entry);
        entries.push(entry);
        // garante createdAt estritamente crescente entre lançamentos, como aconteceria sob o
        // lock pessimista por walletId (nunca duas escritas concorrentes na mesma wallet).
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const page = await makeRepo().findByWalletId(walletId, { limit: 2 });

      expect(page.map((e) => e.id)).toEqual([entries[0]?.id, entries[1]?.id]);
      expect(page[0]?.createdAt.getTime()).toBeLessThanOrEqual(page[1]?.createdAt.getTime() as number);
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });

  test("a second call with the previous page's cursor returns exactly the remaining entry", async () => {
    const walletId = await seedWallet();
    const transactionIds = [await seedTransaction(walletId), await seedTransaction(walletId), await seedTransaction(walletId)];
    try {
      const entries: WalletLedgerEntry[] = [];
      let balance = Money.from({ amount: "500.00", currency: "BRL" });
      for (const transactionId of transactionIds) {
        const debit = Money.from({ amount: "10.00", currency: "BRL" });
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId,
          direction: "DEBIT",
          money: debit,
          balanceBefore: balance,
          balanceAfter: balance.subtract(debit),
        });
        balance = balance.subtract(debit);
        await makeRepo().save(entry);
        entries.push(entry);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const firstPage = await makeRepo().findByWalletId(walletId, { limit: 2 });
      const lastOfFirstPage = firstPage[firstPage.length - 1];
      if (!lastOfFirstPage) throw new Error("expected a non-empty first page");
      const cursor = encodeLedgerCursor(lastOfFirstPage, cursorSecret);

      const secondPage = await makeRepo().findByWalletId(walletId, { cursor, limit: 2 });

      expect(secondPage.map((e) => e.id)).toEqual([entries[2]?.id]);
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });

  test("findByWalletId propagates InvalidLedgerCursorError for a tampered cursor", async () => {
    const walletId = await seedWallet();
    const transactionId = await seedTransaction(walletId);
    try {
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: "DEBIT",
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "500.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "490.00", currency: "BRL" }),
      });
      await makeRepo().save(entry);

      const cursor = encodeLedgerCursor(entry, cursorSecret);
      const [payload, signature] = cursor.split(".") as [string, string];
      // XOR no primeiro byte decodificado, não no último caractere da string: o último
      // caractere de uma assinatura HMAC-SHA256 em base64url carrega bits de padding ignorados
      // na decodificação - trocar só ele por sorteio (ex.: entre "A" e "B") às vezes decodifica
      // para o mesmo byte e deixa a assinatura "adulterada" batendo com a esperada. Invertendo
      // todos os bits de um byte real do buffer, a diferença é garantida.
      const tamperedSignatureBytes = Buffer.from(signature, "base64url");
      tamperedSignatureBytes[0] = tamperedSignatureBytes[0] ^ 0xff;
      const tamperedCursor = `${payload}.${tamperedSignatureBytes.toString("base64url")}`;

      await expect(makeRepo().findByWalletId(walletId, { cursor: tamperedCursor, limit: 2 })).rejects.toThrow(
        InvalidLedgerCursorError,
      );
    } finally {
      await deleteLedgerEntries(walletId);
      await deleteTransactions(walletId);
      await deleteWallet(walletId);
    }
  });
});
