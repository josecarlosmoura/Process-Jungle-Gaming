import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

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

function ensureMigrationApplied(): void {
  // migration:up nao reaplica uma migration ja registrada em mikro_orm_migrations - chamar em
  // todo teste garante a pre-condicao sem depender da ordem de execucao entre os describes.
  execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
}

async function createWallet(): Promise<string> {
  const id = randomUUID();
  await connection.execute(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values (?, ?, 'BRL', '100.00', 1, now(), now())`,
    [id, randomUUID()],
  );
  return id;
}

async function deleteWallet(id: string): Promise<void> {
  await connection.execute("delete from wallets where id = ?", [id]);
}

async function deleteWagerTransaction(id: string): Promise<void> {
  await connection.execute("delete from wager_transactions where id = ?", [id]);
}

async function insertLedgerEntry(id: string, walletId: string, transactionId: string): Promise<void> {
  await connection.execute(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before_amount, balance_after_amount, created_at)
     values (?, ?, ?, 'CREDIT', '100.00', 'BRL', '0.00', '100.00', now())`,
    [id, walletId, transactionId],
  );
}

async function columnIsNotNullable(table: string, column: string): Promise<boolean> {
  const rows = await connection.execute<{ is_nullable: "YES" | "NO" }[]>(
    `select is_nullable from information_schema.columns where table_name = ? and column_name = ?`,
    [table, column],
  );
  return rows[0]?.is_nullable === "NO";
}

interface InsertParams {
  id: string;
  walletId: string;
  kind: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string;
  payloadHash: string | null;
  roundId: string | null;
  gameId: string | null;
}

function insertWagerTransaction(params: InsertParams): Promise<unknown> {
  return connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10.00', 'BRL', 'PENDING', now())`,
    [
      params.id,
      params.providerId,
      params.externalTransactionId,
      params.idempotencyKey,
      params.payloadHash,
      params.walletId,
      randomUUID(),
      params.roundId,
      params.gameId,
      params.kind,
    ],
  );
}

function nonOpeningParams(id: string, walletId: string): InsertParams {
  return {
    id,
    walletId,
    kind: "BET",
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: `key:${id}`,
    payloadHash: randomUUID(),
    roundId: "round-a",
    gameId: "game-a",
  };
}

function openingParams(id: string, walletId: string): InsertParams {
  return {
    id,
    walletId,
    kind: "OPENING",
    providerId: null,
    externalTransactionId: null,
    idempotencyKey: `internal:${id}`,
    payloadHash: null,
    roundId: null,
    gameId: null,
  };
}

afterAll(async () => {
  await orm.close();
});

describe("wager_transactions opening-fields nullability (migration:up)", () => {
  test("an insert with kind OPENING and all five provider fields null succeeds", async () => {
    ensureMigrationApplied();
    const walletId = await createWallet();
    const id = randomUUID();

    try {
      await insertWagerTransaction(openingParams(id, walletId));

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from wager_transactions where id = ?) as exists",
        [id],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteWagerTransaction(id);
      await deleteWallet(walletId);
    }
  });

  test("an insert with a non-OPENING kind and any of the five provider fields null violates the check constraint", async () => {
    ensureMigrationApplied();
    const walletId = await createWallet();
    const overridesPerField: Array<Partial<InsertParams>> = [
      { providerId: null },
      { externalTransactionId: null },
      { roundId: null },
      { gameId: null },
      { payloadHash: null },
    ];

    try {
      for (const override of overridesPerField) {
        const id = randomUUID();
        const invalidInsert = insertWagerTransaction({ ...nonOpeningParams(id, walletId), ...override });

        await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with kind OPENING and any of the five provider fields non-null violates the check constraint", async () => {
    ensureMigrationApplied();
    const walletId = await createWallet();
    const overridesPerField: Array<Partial<InsertParams>> = [
      { providerId: "provider-a" },
      { externalTransactionId: randomUUID() },
      { roundId: "round-a" },
      { gameId: "game-a" },
      { payloadHash: randomUUID() },
    ];

    try {
      for (const override of overridesPerField) {
        const id = randomUUID();
        const invalidInsert = insertWagerTransaction({ ...openingParams(id, walletId), ...override });

        await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await deleteWallet(walletId);
    }
  });
});

describe("wager_transactions opening-fields nullability (migration:down reverts cleanly even with existing OPENING data)", () => {
  test(
    "migration:down succeeds with an OPENING transaction and its ledger entry already persisted, and restores NOT NULL",
    async () => {
      ensureMigrationApplied();
      const walletId = await createWallet();
      const transactionId = randomUUID();
      const ledgerId = randomUUID();
      await insertWagerTransaction(openingParams(transactionId, walletId));
      await insertLedgerEntry(ledgerId, walletId, transactionId);

      try {
        // reverte so esta migration (a mais recente no momento) - nao deve lancar mesmo com a
        // OPENING/ledger acima ainda persistidos.
        expect(() => execSync("bun run migration:down", { cwd: process.cwd(), stdio: "pipe" })).not.toThrow();

        expect(await columnIsNotNullable("wager_transactions", "provider_id")).toBe(true);

        const remaining = await connection.execute<{ count: string }[]>(
          "select count(*) as count from wager_transactions where id = ?",
          [transactionId],
        );
        expect(Number(remaining[0]?.count)).toBe(0);
      } finally {
        ensureMigrationApplied();
        await deleteWallet(walletId);
      }
    },
    15_000,
  );
});
