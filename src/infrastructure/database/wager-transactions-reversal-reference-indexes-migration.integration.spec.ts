import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

// Forca wagering_test independente de como o teste e invocado - rodando via Test Explorer da
// IDE (sem o script "test" do package.json, cujo "DB_NAME=wagering_test bun test" normalmente
// define essa env var), o .env traria "wagering_dev", e este arquivo roda migration:down --to
// via execSync, que apagaria as tabelas do banco de desenvolvimento.
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

interface IndexInfo {
  is_unique: boolean;
  index_definition: string;
}

async function indexInfo(indexName: string): Promise<IndexInfo | undefined> {
  const rows = await connection.execute<IndexInfo[]>(
    `select ix.indisunique as is_unique, pg_get_indexdef(ix.indexrelid) as index_definition
     from pg_class t
     join pg_index ix on t.oid = ix.indrelid
     join pg_class i on i.oid = ix.indexrelid
     where t.relname = 'wager_transactions' and i.relname = ?`,
    [indexName],
  );
  return rows[0];
}

async function ensureMigrationApplied(): Promise<void> {
  // Garante a pre-condicao sem depender da ordem de execucao entre os describes deste arquivo,
  // mas so paga o custo de subir um processo novo (ts-node + bun + reconexao) quando o indice de
  // fato ainda nao existe.
  if (await indexInfo("wager_transactions_refund_reference_unique")) {
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

async function insertProcessedBet(walletId: string): Promise<string> {
  const id = randomUUID();
  await connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at)
     values (?, 'provider-a', ?, ?, ?, ?, ?, ?, 'game-a', 'BET', '10.00', 'BRL', 'PROCESSED', now())`,
    [id, randomUUID(), `key:${id}`, randomUUID(), walletId, randomUUID(), randomUUID()],
  );
  return id;
}

function insertReversalOrWin(params: {
  id: string;
  walletId: string;
  kind: "REFUND" | "ROLLBACK" | "WIN";
  referenceTransactionId: string;
}): Promise<unknown> {
  return connection.execute(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, money_amount, money_currency, status,
        reference_transaction_id, created_at)
     values (?, 'provider-a', ?, ?, ?, ?, ?, ?, 'game-a', ?, '10.00', 'BRL', 'PROCESSED', ?, now())`,
    [
      params.id,
      randomUUID(),
      `key:${params.id}`,
      randomUUID(),
      params.walletId,
      randomUUID(),
      randomUUID(),
      params.kind,
      params.referenceTransactionId,
    ],
  );
}

afterAll(async () => {
  await orm.close();
});

describe("wager_transactions reversal reference indexes (migration:up)", () => {
  test("the refund and rollback partial unique indexes exist, each unique and filtered by its own kind", async () => {
    await ensureMigrationApplied();

    const refundIndex = await indexInfo("wager_transactions_refund_reference_unique");
    expect(refundIndex?.is_unique).toBe(true);
    expect(refundIndex?.index_definition).toContain("WHERE ((kind = 'REFUND'::text)");

    const rollbackIndex = await indexInfo("wager_transactions_rollback_reference_unique");
    expect(rollbackIndex?.is_unique).toBe(true);
    expect(rollbackIndex?.index_definition).toContain("WHERE ((kind = 'ROLLBACK'::text)");
  });
});

describe("wager_transactions reversal reference indexes - coexistence and uniqueness", () => {
  test("a second REFUND row with the same reference_transaction_id violates the unique constraint", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const referenceId = await insertProcessedBet(walletId);
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertReversalOrWin({ id: firstId, walletId, kind: "REFUND", referenceTransactionId: referenceId });

      const duplicateInsert = insertReversalOrWin({
        id: secondId,
        walletId,
        kind: "REFUND",
        referenceTransactionId: referenceId,
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(secondId);
      await deleteWagerTransaction(referenceId);
      await deleteWallet(walletId);
    }
  });

  test("a second ROLLBACK row with the same reference_transaction_id violates the unique constraint", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const referenceId = await insertProcessedBet(walletId);
    const firstId = randomUUID();
    const secondId = randomUUID();

    try {
      await insertReversalOrWin({ id: firstId, walletId, kind: "ROLLBACK", referenceTransactionId: referenceId });

      const duplicateInsert = insertReversalOrWin({
        id: secondId,
        walletId,
        kind: "ROLLBACK",
        referenceTransactionId: referenceId,
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteWagerTransaction(firstId);
      await deleteWagerTransaction(secondId);
      await deleteWagerTransaction(referenceId);
      await deleteWallet(walletId);
    }
  });

  test("a REFUND and a ROLLBACK row with the same reference_transaction_id both succeed", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const referenceId = await insertProcessedBet(walletId);
    const refundId = randomUUID();
    const rollbackId = randomUUID();

    try {
      await insertReversalOrWin({ id: refundId, walletId, kind: "REFUND", referenceTransactionId: referenceId });
      await insertReversalOrWin({ id: rollbackId, walletId, kind: "ROLLBACK", referenceTransactionId: referenceId });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wager_transactions where reference_transaction_id = ?",
        [referenceId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteWagerTransaction(refundId);
      await deleteWagerTransaction(rollbackId);
      await deleteWagerTransaction(referenceId);
      await deleteWallet(walletId);
    }
  });

  test("two WIN rows with the same reference_transaction_id both succeed", async () => {
    await ensureMigrationApplied();
    const walletId = await createWallet();
    const referenceId = await insertProcessedBet(walletId);
    const firstWinId = randomUUID();
    const secondWinId = randomUUID();

    try {
      await insertReversalOrWin({ id: firstWinId, walletId, kind: "WIN", referenceTransactionId: referenceId });
      await insertReversalOrWin({ id: secondWinId, walletId, kind: "WIN", referenceTransactionId: referenceId });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from wager_transactions where reference_transaction_id = ?",
        [referenceId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteWagerTransaction(firstWinId);
      await deleteWagerTransaction(secondWinId);
      await deleteWagerTransaction(referenceId);
      await deleteWallet(walletId);
    }
  });
});

describe("wager_transactions reversal reference indexes (migration:down)", () => {
  test(
    "drops both partial unique indexes and leaves the rest of the table unchanged",
    async () => {
      await ensureMigrationApplied();
      await expect(indexInfo("wager_transactions_refund_reference_unique")).resolves.toBeDefined();

      try {
        // "--to <nome>" mira a migration imediatamente anterior a esta - reverte so esta (e
        // qualquer uma mais nova), mantendo as anteriores aplicadas; nunca "migration:down" sem
        // argumento, que desfaz so um passo e quebraria assim que outra migration fosse adicionada
        // depois desta (mesmo cuidado documentado em wager-transactions-opening-fields-migration).
        execSync(
          "bun run migration:down -- --to Migration20261113140000_WagerTransactionsBalanceAfterProcessing",
          { cwd: process.cwd(), stdio: "pipe" },
        );

        expect(await indexInfo("wager_transactions_refund_reference_unique")).toBeUndefined();
        expect(await indexInfo("wager_transactions_rollback_reference_unique")).toBeUndefined();

        const columns = await connection.execute<{ column_name: string }[]>(
          `select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'wager_transactions'`,
        );
        expect(columns.map((c) => c.column_name)).toContain("reference_transaction_id");
      } finally {
        // restaura os indices - outros testes deste arquivo assumem que eles existem,
        // independentemente da ordem de execucao
        await ensureMigrationApplied();
      }
    },
    // duas chamadas reais de CLI (cold start de ts-node + bun + reconexao) rotineiramente passam
    // dos 5000ms padrao - nao e travamento (ver migrations.integration.spec.ts).
    20_000,
  );
});
