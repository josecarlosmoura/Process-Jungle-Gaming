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

interface ColumnInfo {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
}

function ensureWalletLedgerEntriesTableExists(): void {
  // migration:up nao reaplica uma migration ja registrada em mikro_orm_migrations -
  // chamar em todo teste garante a pre-condicao sem depender da ordem de execucao
  // entre os describes deste arquivo (mesmo padrao de wager-transactions-migration.integration.spec.ts).
  execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = ?) as exists",
    [table],
  );
  return rows[0]?.exists === true;
}

async function migrationRowExists(namePattern: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from mikro_orm_migrations where name like ?) as exists",
    [namePattern],
  );
  return rows[0]?.exists === true;
}

async function walletLedgerEntriesColumns(): Promise<ColumnInfo[]> {
  return connection.execute<ColumnInfo[]>(
    `select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'wallet_ledger_entries'`,
  );
}

async function walletLedgerEntriesConstraints(): Promise<ConstraintInfo[]> {
  return connection.execute<ConstraintInfo[]>(
    `select constraint_name, constraint_type
     from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'wallet_ledger_entries'`,
  );
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

async function createWagerTransaction(walletId: string): Promise<string> {
  const id = randomUUID();
  const externalTransactionId = randomUUID();
  const providerId = "provider-a";
  await connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', '25.00', 'BRL', 'PROCESSED', now())`,
    [id, providerId, externalTransactionId, `${providerId}:${externalTransactionId}`, randomUUID(), walletId, randomUUID(), randomUUID(), "game-a"],
  );
  return id;
}

async function deleteWagerTransaction(id: string): Promise<void> {
  await connection.execute("delete from wager_transactions where id = ?", [id]);
}

interface InsertLedgerEntryParams {
  id: string;
  walletId: string;
  transactionId: string;
  direction?: string;
  moneyAmount?: string;
  moneyCurrency?: string;
  balanceBeforeAmount?: string;
  balanceAfterAmount?: string;
}

function insertLedgerEntry(params: InsertLedgerEntryParams): Promise<unknown> {
  const direction = params.direction ?? "DEBIT";
  const moneyAmount = params.moneyAmount ?? "25.00";
  const moneyCurrency = params.moneyCurrency ?? "BRL";
  const balanceBeforeAmount = params.balanceBeforeAmount ?? "100.00";
  const balanceAfterAmount = params.balanceAfterAmount ?? (direction === "DEBIT" ? "75.00" : "125.00");

  return connection.execute(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before_amount, balance_after_amount, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [params.id, params.walletId, params.transactionId, direction, moneyAmount, moneyCurrency, balanceBeforeAmount, balanceAfterAmount],
  );
}

async function deleteLedgerEntry(id: string): Promise<void> {
  await connection.execute("delete from wallet_ledger_entries where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("wallet_ledger_entries table schema (migration:up)", () => {
  test("migration:up creates the wallet_ledger_entries table with exactly the expected 9 columns", async () => {
    ensureWalletLedgerEntriesTableExists();

    const columns = await walletLedgerEntriesColumns();
    const columnNames = columns.map((c) => c.column_name).sort();

    expect(columnNames).toEqual(
      [
        "id",
        "wallet_id",
        "transaction_id",
        "direction",
        "money_amount",
        "money_currency",
        "balance_before_amount",
        "balance_after_amount",
        "created_at",
      ].sort(),
    );

    const idColumn = columns.find((c) => c.column_name === "id");
    expect(idColumn?.data_type).toBe("uuid");

    const walletIdColumn = columns.find((c) => c.column_name === "wallet_id");
    expect(walletIdColumn?.data_type).toBe("uuid");

    const transactionIdColumn = columns.find((c) => c.column_name === "transaction_id");
    expect(transactionIdColumn?.data_type).toBe("uuid");
  });

  test("the money_amount, balance_before_amount and balance_after_amount columns are numeric with precision 19 and scale 2", async () => {
    ensureWalletLedgerEntriesTableExists();

    const columns = await walletLedgerEntriesColumns();

    for (const name of ["money_amount", "balance_before_amount", "balance_after_amount"]) {
      const column = columns.find((c) => c.column_name === name);
      expect(column?.data_type).toBe("numeric");
      expect(column?.numeric_precision).toBe(19);
      expect(column?.numeric_scale).toBe(2);
    }
  });

  test("the money_currency column is character with length 3", async () => {
    ensureWalletLedgerEntriesTableExists();

    const columns = await walletLedgerEntriesColumns();
    const moneyCurrency = columns.find((c) => c.column_name === "money_currency");

    expect(moneyCurrency?.data_type).toBe("character");
    expect(moneyCurrency?.character_maximum_length).toBe(3);
  });

  test("all columns of wallet_ledger_entries are not nullable", async () => {
    ensureWalletLedgerEntriesTableExists();

    const columns = await walletLedgerEntriesColumns();
    const nullability = new Map(columns.map((c) => [c.column_name, c.is_nullable]));

    const notNullable = [
      "id",
      "wallet_id",
      "transaction_id",
      "direction",
      "money_amount",
      "money_currency",
      "balance_before_amount",
      "balance_after_amount",
      "created_at",
    ];

    for (const name of notNullable) {
      expect(nullability.get(name)).toBe("NO");
    }
  });

  test("the unique constraint on wallet_id and transaction_id has the expected literal name", async () => {
    ensureWalletLedgerEntriesTableExists();

    const names = (await walletLedgerEntriesConstraints()).map((c) => c.constraint_name);

    expect(names).toContain("wallet_ledger_entries_wallet_id_transaction_id_unique");
  });
});

describe("wallet_ledger_entries table reversibility (migration:down)", () => {
  test("migration:down drops the wallet_ledger_entries table and removes its row from mikro_orm_migrations", async () => {
    ensureWalletLedgerEntriesTableExists();
    await expect(tableExists("wallet_ledger_entries")).resolves.toBe(true);

    // "--to 0" reverte TODAS as migrations, independente de quantas existirem depois desta no
    // futuro - mesmo padrao ja usado nas outras suites de migration deste diretorio.
    execSync("bun run migration:down -- --to 0", { cwd: process.cwd(), stdio: "pipe" });

    await expect(tableExists("wallet_ledger_entries")).resolves.toBe(false);
    await expect(migrationRowExists("%CreateWalletLedgerEntries%")).resolves.toBe(false);

    // restaura a tabela - outros testes deste arquivo assumem que ela existe,
    // independentemente da ordem de execucao
    execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
  });
});

describe("wallet_ledger_entries uniqueness per (wallet_id, transaction_id)", () => {
  test("a second insert with the same wallet_id and transaction_id violates the unique constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const firstId = randomUUID();
    const duplicateId = randomUUID();

    try {
      await insertLedgerEntry({ id: firstId, walletId, transactionId });

      const duplicateInsert = insertLedgerEntry({ id: duplicateId, walletId, transactionId });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteLedgerEntry(firstId);
      await deleteLedgerEntry(duplicateId);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("a second insert with the same wallet_id but a different transaction_id succeeds", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const firstTransactionId = await createWagerTransaction(walletId);
    const secondTransactionId = await createWagerTransaction(walletId);
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertLedgerEntry({ id: firstId, walletId, transactionId: firstTransactionId });
      await insertLedgerEntry({ id: secondId, walletId, transactionId: secondTransactionId });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wallet_ledger_entries where wallet_id = ?",
        [walletId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteLedgerEntry(firstId);
      await deleteLedgerEntry(secondId);
      await deleteWagerTransaction(firstTransactionId);
      await deleteWagerTransaction(secondTransactionId);
      await deleteWallet(walletId);
    }
  });

  test("a second insert with a different wallet_id but the same transaction_id succeeds", async () => {
    ensureWalletLedgerEntriesTableExists();
    const firstWalletId = await createWallet();
    const secondWalletId = await createWallet();
    const transactionId = await createWagerTransaction(firstWalletId);
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertLedgerEntry({ id: firstId, walletId: firstWalletId, transactionId });
      await insertLedgerEntry({ id: secondId, walletId: secondWalletId, transactionId });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wallet_ledger_entries where transaction_id = ?",
        [transactionId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteLedgerEntry(firstId);
      await deleteLedgerEntry(secondId);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(firstWalletId);
      await deleteWallet(secondWalletId);
    }
  });
});

describe("wallet_ledger_entries referential integrity, closed direction domain and balance arithmetic", () => {
  test("an insert with a wallet_id that does not exist violates the foreign key constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      const invalidInsert = insertLedgerEntry({ id: randomUUID(), walletId: randomUUID(), transactionId });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with a transaction_id that does not exist violates the foreign key constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();

    try {
      const invalidInsert = insertLedgerEntry({ id: randomUUID(), walletId, transactionId: randomUUID() });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with direction DEBIT succeeds", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const id = randomUUID();

    try {
      await insertLedgerEntry({ id, walletId, transactionId, direction: "DEBIT" });

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from wallet_ledger_entries where id = ?) as exists",
        [id],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteLedgerEntry(id);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with an invalid direction violates the check constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      const invalidInsert = insertLedgerEntry({ id: randomUUID(), walletId, transactionId, direction: "TRANSFER" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with direction DEBIT and correct balance arithmetic succeeds", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const id = randomUUID();

    try {
      await insertLedgerEntry({
        id,
        walletId,
        transactionId,
        direction: "DEBIT",
        moneyAmount: "25.00",
        balanceBeforeAmount: "100.00",
        balanceAfterAmount: "75.00",
      });

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from wallet_ledger_entries where id = ?) as exists",
        [id],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteLedgerEntry(id);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with direction DEBIT and incorrect balance arithmetic violates the check constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      const invalidInsert = insertLedgerEntry({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: "DEBIT",
        moneyAmount: "25.00",
        balanceBeforeAmount: "100.00",
        balanceAfterAmount: "80.00",
      });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with direction CREDIT and correct balance arithmetic succeeds", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const id = randomUUID();

    try {
      await insertLedgerEntry({
        id,
        walletId,
        transactionId,
        direction: "CREDIT",
        moneyAmount: "25.00",
        balanceBeforeAmount: "100.00",
        balanceAfterAmount: "125.00",
      });

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from wallet_ledger_entries where id = ?) as exists",
        [id],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteLedgerEntry(id);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with direction CREDIT and incorrect balance arithmetic violates the check constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      const invalidInsert = insertLedgerEntry({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: "CREDIT",
        moneyAmount: "25.00",
        balanceBeforeAmount: "100.00",
        balanceAfterAmount: "120.00",
      });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with a currency shorter than 3 letters violates the check constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      // char(3) por si so faz padding com espaco em branco em vez de rejeitar um valor mais
      // curto (ex.: "BR" vira "BR "), mesma lacuna ja fechada nas outras tabelas monetarias - ver
      // wallet_ledger_entries_money_currency_format.
      const invalidInsert = insertLedgerEntry({ id: randomUUID(), walletId, transactionId, moneyCurrency: "BR" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("an insert with a lowercase currency violates the check constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);

    try {
      const invalidInsert = insertLedgerEntry({ id: randomUUID(), walletId, transactionId, moneyCurrency: "brl" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("deleting a wallet still referenced by a wallet_ledger_entry violates the restrict constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const entryId = randomUUID();

    try {
      await insertLedgerEntry({ id: entryId, walletId, transactionId });

      await expect(deleteWallet(walletId)).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteLedgerEntry(entryId);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("deleting a wager_transaction still referenced by a wallet_ledger_entry violates the restrict constraint", async () => {
    ensureWalletLedgerEntriesTableExists();
    const walletId = await createWallet();
    const transactionId = await createWagerTransaction(walletId);
    const entryId = randomUUID();

    try {
      await insertLedgerEntry({ id: entryId, walletId, transactionId });

      await expect(deleteWagerTransaction(transactionId)).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteLedgerEntry(entryId);
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });
});
