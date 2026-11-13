import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

// Forca wagering_test independente de como o teste e invocado - rodando via Test Explorer da
// IDE (sem o script "test" do package.json, cujo "DB_NAME=wagering_test bun test" normalmente
// define essa env var), o .env traria "wagering_dev", e este arquivo roda migration:down --to 0
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

async function tableExists(table: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = ?) as exists",
    [table],
  );
  return rows[0]?.exists === true;
}

async function ensureMigrationApplied(): Promise<void> {
  // Garante a pre-condicao sem depender da ordem de execucao entre os describes, mas so
  // paga o custo de subir um processo novo (ts-node + bun + reconexao, cold start que
  // rotineiramente passa de 1s) quando a migration de fato ainda nao foi aplicada - checado
  // pela nullability de "provider_id" (NOT NULL antes desta migration, nullable depois). A
  // checagem de tableExists evita concluir "ja aplicada" por engano quando a tabela em si
  // ainda nao existe (coluna inexistente tambem "parece" nullable pela query).
  if ((await tableExists("wager_transactions")) && !(await columnIsNotNullable("wager_transactions", "provider_id"))) {
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
    await ensureMigrationApplied();
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
    await ensureMigrationApplied();
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
    await ensureMigrationApplied();
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
      await ensureMigrationApplied();
      const walletId = await createWallet();
      const transactionId = randomUUID();
      const ledgerId = randomUUID();
      await insertWagerTransaction(openingParams(transactionId, walletId));
      await insertLedgerEntry(ledgerId, walletId, transactionId);

      try {
        // "--to <nome>" mira esta migration especificamente (reverte ela e qualquer uma mais
        // nova, mantendo as anteriores aplicadas) - nunca "migration:down" sem argumento, que
        // desfaz so um passo: isso quebraria assim que qualquer migration nova fosse adicionada
        // depois desta (ja aconteceu: a migration de snapshot de saldo passou a ser "o passo
        // mais recente", fazendo o passo cego reverter ela, nao esta, e nunca apagar a linha
        // OPENING - achado ao investigar um FK violation nao relacionado nesta mesma sessao).
        // Nao deve lancar mesmo com a OPENING/ledger acima ainda persistidos.
        expect(() =>
          execSync("bun run migration:down -- --to Migration20261113090000_WagerTransactionsOpeningFieldsNullable", {
            cwd: process.cwd(),
            stdio: "pipe",
          }),
        ).not.toThrow();

        expect(await columnIsNotNullable("wager_transactions", "provider_id")).toBe(true);

        const remaining = await connection.execute<{ count: string }[]>(
          "select count(*) as count from wager_transactions where id = ?",
          [transactionId],
        );
        expect(Number(remaining[0]?.count)).toBe(0);
      } finally {
        await ensureMigrationApplied();
        await deleteWallet(walletId);
      }
    },
    // duas chamadas reais de CLI (cold start de ts-node + bun + reconexao) rotineiramente
    // passam dos 5000ms padrao - nao e travamento (ver migrations.integration.spec.ts).
    20_000,
  );
});
