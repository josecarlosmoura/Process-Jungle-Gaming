import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

// Forca wagering_test independente de como o teste e invocado - ver o mesmo comentario em
// wager-transactions-reversal-reference-indexes-migration.integration.spec.ts.
Object.assign(process.env, { DB_NAME: "wagering_test" });

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
  data_type: string;
  is_nullable: string;
}

async function columnInfo(columnName: string): Promise<ColumnInfo | undefined> {
  const rows = await connection.execute<ColumnInfo[]>(
    `select data_type, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'wager_transactions' and column_name = ?`,
    [columnName],
  );
  return rows[0];
}

interface TableSchemaSnapshot {
  columns: string[];
  constraints: string[];
  indexes: string[];
}

async function wagerTransactionsSchemaSnapshot(): Promise<TableSchemaSnapshot> {
  const columns = await connection.execute<{ column_name: string; data_type: string; is_nullable: string }[]>(
    `select column_name, data_type, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'wager_transactions' order by column_name`,
  );
  const constraints = await connection.execute<{ constraint_name: string; constraint_type: string }[]>(
    `select constraint_name, constraint_type from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'wager_transactions' order by constraint_name`,
  );
  const indexes = await connection.execute<{ indexname: string }[]>(
    `select indexname from pg_indexes where schemaname = 'public' and tablename = 'wager_transactions' order by indexname`,
  );
  return {
    columns: columns.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`),
    constraints: constraints.map((c) => `${c.constraint_name}:${c.constraint_type}`),
    indexes: indexes.map((i) => i.indexname),
  };
}

async function ensureMigrationApplied(): Promise<void> {
  // Mesma estrategia de custo das demais migration specs: so paga o processo novo quando a
  // coluna de fato ainda nao existe.
  if (await columnInfo("attempts")) {
    return;
  }
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

async function insertBet(walletId: string): Promise<string> {
  const id = randomUUID();
  await connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at)
     values (?, 'provider-a', ?, ?, ?, ?, ?, ?, 'game-a', 'BET', '10.00', 'BRL', 'PENDING', now())`,
    [id, randomUUID(), `key:${id}`, randomUUID(), walletId, randomUUID(), randomUUID()],
  );
  return id;
}

afterAll(async () => {
  await orm.close();
});

describe("wager_transactions pending reference metadata (migration:up)", () => {
  test("attempts and next_attempt_at exist, nullable, paired and non-negative", async () => {
    await ensureMigrationApplied();

    const attempts = await columnInfo("attempts");
    expect(attempts?.data_type).toBe("integer");
    expect(attempts?.is_nullable).toBe("YES");

    const nextAttemptAt = await columnInfo("next_attempt_at");
    expect(nextAttemptAt?.data_type).toBe("timestamp with time zone");
    expect(nextAttemptAt?.is_nullable).toBe("YES");
  });
});

describe("wager_transactions pending reference metadata - pair and non-negative checks", () => {
  test("attempts without next_attempt_at violates the pair check", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const betId = await insertBet(walletId);

    try {
      await expect(
        connection.execute("update wager_transactions set attempts = 0, next_attempt_at = null where id = ?", [betId]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(betId);
      await deleteWallet(walletId);
    }
  });

  test("next_attempt_at without attempts violates the pair check", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const betId = await insertBet(walletId);

    try {
      await expect(
        connection.execute("update wager_transactions set attempts = null, next_attempt_at = now() where id = ?", [
          betId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(betId);
      await deleteWallet(walletId);
    }
  });

  test("a negative attempts value violates the non-negative check", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const betId = await insertBet(walletId);

    try {
      await expect(
        connection.execute("update wager_transactions set attempts = -1, next_attempt_at = now() where id = ?", [
          betId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await deleteWagerTransaction(betId);
      await deleteWallet(walletId);
    }
  });

  test("both columns set together succeed", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const betId = await insertBet(walletId);

    try {
      await connection.execute("update wager_transactions set attempts = 0, next_attempt_at = now() where id = ?", [
        betId,
      ]);

      const rows = await connection.execute<{ attempts: number }[]>(
        "select attempts from wager_transactions where id = ?",
        [betId],
      );
      expect(rows[0]?.attempts).toBe(0);
    } finally {
      await deleteWagerTransaction(betId);
      await deleteWallet(walletId);
    }
  });
});

describe("wager_transactions pending reference metadata (migration:down)", () => {
  test(
    "drops both columns and both constraints, leaving the rest of the table unchanged",
    async () => {
      await ensureMigrationApplied();
      const beforeDown = await wagerTransactionsSchemaSnapshot();
      expect(beforeDown.columns).toContain("attempts:integer:YES");
      expect(beforeDown.constraints).toContain("wager_transactions_pending_reference_metadata_pair_check:CHECK");

      try {
        execSync(
          "bun run migration:down -- --to Migration20261113160000_WagerTransactionsPendingReferenceMetadata",
          { cwd: process.cwd(), stdio: "pipe" },
        );

        const afterDown = await wagerTransactionsSchemaSnapshot();

        expect(afterDown.columns).not.toContain("attempts:integer:YES");
        expect(afterDown.columns).not.toContain("next_attempt_at:timestamp with time zone:YES");
        expect(afterDown.constraints).not.toContain(
          "wager_transactions_pending_reference_metadata_pair_check:CHECK",
        );
        expect(afterDown.constraints).not.toContain("wager_transactions_attempts_non_negative_check:CHECK");

        expect(afterDown.indexes).toEqual(beforeDown.indexes);
        expect(afterDown.columns).toEqual(
          beforeDown.columns.filter((c) => c !== "attempts:integer:YES" && c !== "next_attempt_at:timestamp with time zone:YES"),
        );
        expect(afterDown.constraints).toEqual(
          beforeDown.constraints.filter(
            (c) =>
              c !== "wager_transactions_pending_reference_metadata_pair_check:CHECK" &&
              c !== "wager_transactions_attempts_non_negative_check:CHECK",
          ),
        );
      } finally {
        // restaura as colunas - outros testes deste arquivo assumem que elas existem,
        // independentemente da ordem de execucao
        await ensureMigrationApplied();
      }
    },
    // duas chamadas reais de CLI (cold start de ts-node + bun + reconexao) rotineiramente passam
    // dos 5000ms padrao - nao e travamento (ver migrations.integration.spec.ts).
    20_000,
  );
});
