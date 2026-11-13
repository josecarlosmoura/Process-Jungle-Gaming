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

function ensureWagerTransactionsTableExists(): void {
  // migration:up nao reaplica uma migration ja registrada em mikro_orm_migrations -
  // chamar em todo teste garante a pre-condicao sem depender da ordem de execucao
  // entre os describes deste arquivo (mesmo padrao de wallets-migration.integration.spec.ts, T102).
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

async function wagerTransactionsColumns(): Promise<ColumnInfo[]> {
  return connection.execute<ColumnInfo[]>(
    `select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'wager_transactions'`,
  );
}

async function wagerTransactionsConstraints(): Promise<ConstraintInfo[]> {
  return connection.execute<ConstraintInfo[]>(
    `select constraint_name, constraint_type
     from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'wager_transactions'`,
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

interface InsertWagerTransactionParams {
  id: string;
  walletId: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: string;
  status?: string;
  moneyCurrency?: string;
  referenceTransactionId?: string | null;
  referenceExternalTransactionId?: string | null;
}

function insertWagerTransaction(params: InsertWagerTransactionParams): Promise<unknown> {
  const providerId = params.providerId ?? "provider-a";
  const externalTransactionId = params.externalTransactionId ?? params.id;
  const idempotencyKey = params.idempotencyKey ?? `${providerId}:${externalTransactionId}`;
  const kind = params.kind ?? "BET";
  const status = params.status ?? "PENDING";
  const moneyCurrency = params.moneyCurrency ?? "BRL";

  return connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency,
        reference_external_transaction_id, status, reference_transaction_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10.00', ?, ?, ?, ?, now())`,
    [
      params.id,
      providerId,
      externalTransactionId,
      idempotencyKey,
      randomUUID(),
      params.walletId,
      randomUUID(),
      randomUUID(),
      "game-a",
      kind,
      moneyCurrency,
      params.referenceExternalTransactionId ?? null,
      status,
      params.referenceTransactionId ?? null,
    ],
  );
}

async function deleteWagerTransaction(id: string): Promise<void> {
  await connection.execute("delete from wager_transactions where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("wager_transactions table schema (migration:up)", () => {
  test("migration:up creates the wager_transactions table with exactly the expected 20 columns", async () => {
    ensureWagerTransactionsTableExists();

    const columns = await wagerTransactionsColumns();
    const columnNames = columns.map((c) => c.column_name).sort();

    expect(columnNames).toEqual(
      [
        "id",
        "provider_id",
        "external_transaction_id",
        "idempotency_key",
        "payload_hash",
        "wallet_id",
        "player_id",
        "round_id",
        "game_id",
        "kind",
        "money_amount",
        "money_currency",
        "reference_external_transaction_id",
        "status",
        "reference_transaction_id",
        "failure_code",
        "created_at",
        "processed_at",
        // balance_after_amount/balance_after_currency: snapshot do saldo no processamento, so
        // preenchido para transacoes PROCESSED sem WalletLedgerEntry (hoje, so LOSS) - AD-006.
        "balance_after_amount",
        "balance_after_currency",
      ].sort(),
    );

    const idColumn = columns.find((c) => c.column_name === "id");
    expect(idColumn?.data_type).toBe("uuid");

    const walletIdColumn = columns.find((c) => c.column_name === "wallet_id");
    expect(walletIdColumn?.data_type).toBe("uuid");
  });

  test("the money_amount column is numeric with precision 19 and scale 2", async () => {
    ensureWagerTransactionsTableExists();

    const columns = await wagerTransactionsColumns();
    const moneyAmount = columns.find((c) => c.column_name === "money_amount");

    expect(moneyAmount?.data_type).toBe("numeric");
    expect(moneyAmount?.numeric_precision).toBe(19);
    expect(moneyAmount?.numeric_scale).toBe(2);
  });

  test("the money_currency column is character with length 3", async () => {
    ensureWagerTransactionsTableExists();

    const columns = await wagerTransactionsColumns();
    const moneyCurrency = columns.find((c) => c.column_name === "money_currency");

    expect(moneyCurrency?.data_type).toBe("character");
    expect(moneyCurrency?.character_maximum_length).toBe(3);
  });

  test("the status column defaults to PENDING and is not nullable", async () => {
    ensureWagerTransactionsTableExists();

    const columns = await wagerTransactionsColumns();
    const status = columns.find((c) => c.column_name === "status");

    expect(status?.is_nullable).toBe("NO");
    expect(status?.column_default).toBe("'PENDING'::text");
  });

  test("the required and optional columns match the expected nullability", async () => {
    ensureWagerTransactionsTableExists();

    const columns = await wagerTransactionsColumns();
    const nullability = new Map(columns.map((c) => [c.column_name, c.is_nullable]));

    const notNullable = [
      "id",
      "idempotency_key",
      "wallet_id",
      "player_id",
      "kind",
      "money_amount",
      "money_currency",
      "status",
      "created_at",
    ];
    const nullable = [
      "provider_id",
      "external_transaction_id",
      "round_id",
      "game_id",
      "payload_hash",
      "reference_external_transaction_id",
      "reference_transaction_id",
      "failure_code",
      "processed_at",
      "balance_after_amount",
      "balance_after_currency",
    ];

    for (const name of notNullable) {
      expect(nullability.get(name)).toBe("NO");
    }
    for (const name of nullable) {
      expect(nullability.get(name)).toBe("YES");
    }
  });

  test("the unique constraints have the expected literal names", async () => {
    ensureWagerTransactionsTableExists();

    const names = (await wagerTransactionsConstraints()).map((c) => c.constraint_name);

    expect(names).toContain("wager_transactions_idempotency_key_unique");
    expect(names).toContain("wager_transactions_provider_id_external_transaction_id_unique");
  });
});

describe("wager_transactions table reversibility (migration:down)", () => {
  test("migration:down drops the wager_transactions table and removes its row from mikro_orm_migrations", async () => {
    ensureWagerTransactionsTableExists();
    await expect(tableExists("wager_transactions")).resolves.toBe(true);

    // "migration:down" sem argumento desfaz so um passo (a migration mais recente) - a partir da
    // migration do ledger de wallet, que depende de wager_transactions via FK, isso deixou de ser
    // CreateWagerTransactions. "--to 0" reverte TODAS as migrations, independente de quantas
    // existirem depois desta, mesmo padrao ja usado nas outras suites de migration deste diretorio.
    execSync("bun run migration:down -- --to 0", { cwd: process.cwd(), stdio: "pipe" });

    await expect(tableExists("wager_transactions")).resolves.toBe(false);
    await expect(migrationRowExists("%CreateWagerTransactions%")).resolves.toBe(false);

    // restaura a tabela - outros testes deste arquivo assumem que ela existe,
    // independentemente da ordem de execucao
    execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
  });
});

describe("wager_transactions idempotency and external reference uniqueness", () => {
  test("a second insert with the same idempotency_key violates the unique constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const firstId = randomUUID();
    const duplicateId = randomUUID();
    const idempotencyKey = `shared-key:${randomUUID()}`;

    try {
      await insertWagerTransaction({ id: firstId, walletId, idempotencyKey });

      const duplicateInsert = insertWagerTransaction({
        id: duplicateId,
        walletId,
        idempotencyKey,
        providerId: "provider-b",
        externalTransactionId: randomUUID(),
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(duplicateId);
      await deleteWallet(walletId);
    }
  });

  test("a second insert with the same provider_id and external_transaction_id violates the unique constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const providerId = "provider-a";
    const externalTransactionId = randomUUID();
    const firstId = randomUUID();
    const duplicateId = randomUUID();

    try {
      await insertWagerTransaction({ id: firstId, walletId, providerId, externalTransactionId });

      const duplicateInsert = insertWagerTransaction({
        id: duplicateId,
        walletId,
        providerId,
        externalTransactionId,
        idempotencyKey: `other-key:${randomUUID()}`,
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(duplicateId);
      await deleteWallet(walletId);
    }
  });

  test("a second insert with the same external_transaction_id but a different provider_id succeeds", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const externalTransactionId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertWagerTransaction({
        id: firstId,
        walletId,
        providerId: "provider-a",
        externalTransactionId,
      });
      await insertWagerTransaction({
        id: secondId,
        walletId,
        providerId: "provider-b",
        externalTransactionId,
      });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wager_transactions where external_transaction_id = ?",
        [externalTransactionId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(secondId);
      await deleteWallet(walletId);
    }
  });
});

describe("wager_transactions referential integrity and closed kind/status domains", () => {
  test("an insert with a wallet_id that does not exist violates the foreign key constraint", async () => {
    ensureWagerTransactionsTableExists();

    const invalidInsert = insertWagerTransaction({ id: randomUUID(), walletId: randomUUID() });

    await expect(invalidInsert).rejects.toMatchObject({ code: "23503" });
  });

  test("an insert with a reference_transaction_id that does not exist violates the foreign key constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const id = randomUUID();

    try {
      const invalidInsert = insertWagerTransaction({
        id,
        walletId,
        kind: "REFUND",
        referenceTransactionId: randomUUID(),
      });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with kind BET succeeds", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const id = randomUUID();

    try {
      await insertWagerTransaction({ id, walletId, kind: "BET" });

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

  test("an insert with an invalid kind violates the check constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();

    try {
      const invalidInsert = insertWagerTransaction({ id: randomUUID(), walletId, kind: "CANCEL" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with status PROCESSED succeeds", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const id = randomUUID();

    try {
      await insertWagerTransaction({ id, walletId, status: "PROCESSED" });

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

  test("an insert with an invalid status violates the check constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();

    try {
      const invalidInsert = insertWagerTransaction({ id: randomUUID(), walletId, status: "CANCELLED" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with a currency shorter than 3 letters violates the check constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();

    try {
      // char(3) por si so faz padding com espaco em branco em vez de rejeitar um valor mais
      // curto (ex.: "BR" vira "BR "), mesma lacuna ja fechada em wallets (T102) - ver
      // wager_transactions_money_currency_format.
      const invalidInsert = insertWagerTransaction({ id: randomUUID(), walletId, moneyCurrency: "BR" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with a lowercase currency violates the check constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();

    try {
      const invalidInsert = insertWagerTransaction({ id: randomUUID(), walletId, moneyCurrency: "brl" });

      await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("the provider_id and reference_external_transaction_id index exists and allows duplicate pairs", async () => {
    ensureWagerTransactionsTableExists();

    const indexRows = await connection.execute<{ is_unique: boolean }[]>(
      `select ix.indisunique as is_unique
       from pg_class t
       join pg_index ix on t.oid = ix.indrelid
       join pg_class i on i.oid = ix.indexrelid
       where t.relname = 'wager_transactions' and i.relname = ?`,
      ["wager_transactions_provider_reference_idx"],
    );
    expect(indexRows.length).toBe(1);
    expect(indexRows[0]?.is_unique).toBe(false);

    const walletId = await createWallet();
    const providerId = "provider-dup";
    const referenceExternalTransactionId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertWagerTransaction({
        id: firstId,
        walletId,
        providerId,
        externalTransactionId: randomUUID(),
        kind: "REFUND",
        referenceExternalTransactionId,
      });
      await insertWagerTransaction({
        id: secondId,
        walletId,
        providerId,
        externalTransactionId: randomUUID(),
        kind: "ROLLBACK",
        referenceExternalTransactionId,
      });

      const countRows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wager_transactions where provider_id = ? and reference_external_transaction_id = ?",
        [providerId, referenceExternalTransactionId],
      );
      expect(Number(countRows[0]?.count)).toBe(2);
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(secondId);
      await deleteWallet(walletId);
    }
  });

  test("deleting a wallet still referenced by a wager_transaction violates the restrict constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const transactionId = randomUUID();

    try {
      await insertWagerTransaction({ id: transactionId, walletId });

      await expect(deleteWallet(walletId)).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteWagerTransaction(transactionId);
      await deleteWallet(walletId);
    }
  });

  test("deleting a wager_transaction still referenced by another transaction's reference_transaction_id violates the restrict constraint", async () => {
    ensureWagerTransactionsTableExists();
    const walletId = await createWallet();
    const originalId = randomUUID();
    const referencingId = randomUUID();

    try {
      await insertWagerTransaction({ id: originalId, walletId, kind: "BET" });
      await insertWagerTransaction({
        id: referencingId,
        walletId,
        kind: "REFUND",
        referenceTransactionId: originalId,
      });

      await expect(deleteWagerTransaction(originalId)).rejects.toMatchObject({ code: "23503" });
    } finally {
      await deleteWagerTransaction(referencingId);
      await deleteWagerTransaction(originalId);
      await deleteWallet(walletId);
    }
  });
});
