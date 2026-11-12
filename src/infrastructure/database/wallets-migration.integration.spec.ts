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

function ensureWalletsTableExists(): void {
  // migration:up nao reaplica uma migration ja registrada em mikro_orm_migrations -
  // chamar em todo teste garante a pre-condicao sem depender da ordem de execucao
  // entre os describes deste arquivo (achado do Verifier em T004: um proof isolado
  // nao pode herdar estado deixado por outro).
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

async function walletsColumns(): Promise<ColumnInfo[]> {
  return connection.execute<ColumnInfo[]>(
    `select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'wallets'`,
  );
}

async function walletsConstraints(): Promise<ConstraintInfo[]> {
  return connection.execute<ConstraintInfo[]>(
    `select constraint_name, constraint_type
     from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'wallets'`,
  );
}

function insertWallet(params: {
  id: string;
  playerId: string;
  currency: string;
  balanceAmount: string;
}): Promise<unknown> {
  return connection.execute(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [params.id, params.playerId, params.currency, params.balanceAmount],
  );
}

async function deleteWallet(id: string): Promise<void> {
  await connection.execute("delete from wallets where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("wallets table schema (migration:up)", () => {
  test("migration:up creates the wallets table with exactly the id, player_id, currency, balance_amount, version, created_at and updated_at columns", async () => {
    ensureWalletsTableExists();

    const columns = await walletsColumns();
    const columnNames = columns.map((c) => c.column_name).sort();

    expect(columnNames).toEqual(
      ["balance_amount", "created_at", "currency", "id", "player_id", "updated_at", "version"].sort(),
    );

    const idColumn = columns.find((c) => c.column_name === "id");
    expect(idColumn?.data_type).toBe("uuid");

    const playerIdColumn = columns.find((c) => c.column_name === "player_id");
    expect(playerIdColumn?.data_type).toBe("text");
  });

  test("the balance_amount column is numeric with precision 19 and scale 2", async () => {
    ensureWalletsTableExists();

    const columns = await walletsColumns();
    const balanceAmount = columns.find((c) => c.column_name === "balance_amount");

    expect(balanceAmount?.data_type).toBe("numeric");
    expect(balanceAmount?.numeric_precision).toBe(19);
    expect(balanceAmount?.numeric_scale).toBe(2);
  });

  test("the currency column is character with length 3", async () => {
    ensureWalletsTableExists();

    const columns = await walletsColumns();
    const currency = columns.find((c) => c.column_name === "currency");

    expect(currency?.data_type).toBe("character");
    expect(currency?.character_maximum_length).toBe(3);
  });

  test("the version column defaults to 1 and is not nullable", async () => {
    ensureWalletsTableExists();

    const columns = await walletsColumns();
    const version = columns.find((c) => c.column_name === "version");

    expect(version?.is_nullable).toBe("NO");
    expect(version?.column_default).toBe("1");
  });

  test("created_at and updated_at are not nullable", async () => {
    ensureWalletsTableExists();

    const columns = await walletsColumns();
    const createdAt = columns.find((c) => c.column_name === "created_at");
    const updatedAt = columns.find((c) => c.column_name === "updated_at");

    expect(createdAt?.is_nullable).toBe("NO");
    expect(updatedAt?.is_nullable).toBe("NO");
  });

  test("the unique and check constraints have the expected literal names", async () => {
    ensureWalletsTableExists();

    const names = (await walletsConstraints()).map((c) => c.constraint_name);

    expect(names).toContain("wallets_player_id_currency_unique");
    expect(names).toContain("wallets_balance_amount_non_negative");
  });
});

describe("wallets table reversibility (migration:down)", () => {
  test("migration:down drops the wallets table and removes its row from mikro_orm_migrations", async () => {
    ensureWalletsTableExists();
    await expect(tableExists("wallets")).resolves.toBe(true);

    execSync("bun run migration:down", { cwd: process.cwd(), stdio: "pipe" });

    await expect(tableExists("wallets")).resolves.toBe(false);
    await expect(migrationRowExists("%CreateWallets%")).resolves.toBe(false);

    // restaura a tabela - outros testes deste arquivo assumem que ela existe,
    // independentemente da ordem de execucao
    execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
  });
});

describe("wallets table constraints enforced by Postgres", () => {
  test("a second insert with the same player_id and currency violates the unique constraint", async () => {
    ensureWalletsTableExists();
    const playerId = randomUUID();
    const walletId = randomUUID();
    const duplicateId = randomUUID();

    try {
      await insertWallet({ id: walletId, playerId, currency: "BRL", balanceAmount: "100.00" });

      const duplicateInsert = insertWallet({
        id: duplicateId,
        playerId,
        currency: "BRL",
        balanceAmount: "50.00",
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteWallet(walletId);
      await deleteWallet(duplicateId);
    }
  });

  test("a second insert with the same player_id but a different currency succeeds", async () => {
    ensureWalletsTableExists();
    const playerId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertWallet({ id: firstId, playerId, currency: "BRL", balanceAmount: "100.00" });
      await insertWallet({ id: secondId, playerId, currency: "USD", balanceAmount: "50.00" });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wallets where player_id = ?",
        [playerId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteWallet(firstId);
      await deleteWallet(secondId);
    }
  });

  test("an insert with a negative balance_amount violates the check constraint", async () => {
    ensureWalletsTableExists();
    const walletId = randomUUID();

    const invalidInsert = insertWallet({
      id: walletId,
      playerId: randomUUID(),
      currency: "BRL",
      balanceAmount: "-10.00",
    });

    await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
  });

  test("an insert with balance_amount zero succeeds", async () => {
    ensureWalletsTableExists();
    const walletId = randomUUID();

    try {
      await insertWallet({ id: walletId, playerId: randomUUID(), currency: "BRL", balanceAmount: "0.00" });

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from wallets where id = ?) as exists",
        [walletId],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteWallet(walletId);
    }
  });

  test("an insert with a currency shorter than 3 letters violates the check constraint", async () => {
    ensureWalletsTableExists();
    const walletId = randomUUID();

    // char(3) por si so faz padding com espaco em branco em vez de rejeitar um valor mais
    // curto (ex.: "BR" vira "BR "), o que deixaria duas wallets do mesmo player nunca colidirem
    // na UNIQUE (player_id, currency) so porque uma delas tem a moeda truncada - a constraint de
    // formato e quem fecha essa lacuna.
    const shortCurrencyInsert = insertWallet({
      id: walletId,
      playerId: randomUUID(),
      currency: "BR",
      balanceAmount: "10.00",
    });

    await expect(shortCurrencyInsert).rejects.toMatchObject({ code: "23514" });
  });

  test("an insert with a lowercase currency violates the check constraint", async () => {
    ensureWalletsTableExists();
    const walletId = randomUUID();

    const lowercaseCurrencyInsert = insertWallet({
      id: walletId,
      playerId: randomUUID(),
      currency: "brl",
      balanceAmount: "10.00",
    });

    await expect(lowercaseCurrencyInsert).rejects.toMatchObject({ code: "23514" });
  });
});
