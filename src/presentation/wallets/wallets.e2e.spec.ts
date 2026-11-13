import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado (decoracao de classe,
// antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do import dinamico
// de WalletsModule, nunca depois de um import estatico no topo do arquivo (mesmo padrao de
// app.e2e.spec.ts).
Object.assign(process.env, {
  DB_HOST: "localhost",
  DB_PORT: "5440",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering_dev",
  LOCALSTACK_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  LEDGER_CURSOR_SECRET: "dev-only-ledger-cursor-secret-not-for-production",
  PORT: "4312",
});

const { WalletsModule } = await import("./wallets.module");
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");

const PORT = 4312;
const baseUrl = `http://127.0.0.1:${PORT}`;

let app: INestApplication;

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

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WalletsModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(PORT);
});

afterAll(async () => {
  await app.close();
  await orm.close();
});

interface CreateWalletBody {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

interface WalletResponseBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

async function postWallet(body: unknown): Promise<{ status: number; body: WalletResponseBody }> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as WalletResponseBody };
}

async function getWallet(walletId: string): Promise<{ status: number; body: WalletResponseBody }> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}`);
  return { status: response.status, body: (await response.json()) as WalletResponseBody };
}

async function deleteWalletCascade(walletId: string | undefined): Promise<void> {
  if (!walletId) {
    return;
  }
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
  await connection.execute("delete from wallets where id = ?", [walletId]);
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

describe("POST /wallets - sem saldo inicial", () => {
  test("POST /wallets with a zero initialBalance creates a wallet with no OPENING transaction and no ledger entry", async () => {
    const playerId = randomUUID();
    const { status, body } = await postWallet({ playerId, initialBalance: { amount: "0.00", currency: "BRL" } });

    try {
      expect(status).toBe(201);
      expect(body.balance).toEqual({ amount: "0.00", currency: "BRL" });
      expect(body.version).toBe(1);
      expect(await countWhere("wager_transactions", "wallet_id", body.id)).toBe(0);
      expect(await countWhere("wallet_ledger_entries", "wallet_id", body.id)).toBe(0);
    } finally {
      await deleteWalletCascade(body.id);
    }
  });
});

describe("POST /wallets - com saldo inicial positivo", () => {
  test("POST /wallets with a positive initialBalance responds 201 with that balance and version 1", async () => {
    const playerId = randomUUID();
    const { status, body } = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      expect(status).toBe(201);
      expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(body.version).toBe(1);
    } finally {
      await deleteWalletCascade(body.id);
    }
  });

  test("POST /wallets with a positive initialBalance persists one OPENING transaction PROCESSED with null provider fields", async () => {
    const playerId = randomUUID();
    const { body } = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      interface TransactionRow {
        kind: string;
        status: string;
        money_amount: string;
        provider_id: string | null;
        external_transaction_id: string | null;
        round_id: string | null;
        game_id: string | null;
        payload_hash: string | null;
      }
      const rows = await connection.execute<TransactionRow[]>(
        `select kind, status, money_amount, provider_id, external_transaction_id, round_id, game_id, payload_hash
         from wager_transactions where wallet_id = ?`,
        [body.id],
      );

      expect(rows.length).toBe(1);
      expect(rows[0]?.kind).toBe("OPENING");
      expect(rows[0]?.status).toBe("PROCESSED");
      expect(rows[0]?.money_amount).toBe("1000.00");
      expect(rows[0]?.provider_id).toBeNull();
      expect(rows[0]?.external_transaction_id).toBeNull();
      expect(rows[0]?.round_id).toBeNull();
      expect(rows[0]?.game_id).toBeNull();
      expect(rows[0]?.payload_hash).toBeNull();
    } finally {
      await deleteWalletCascade(body.id);
    }
  });

  test("POST /wallets with a positive initialBalance persists one matching CREDIT ledger entry", async () => {
    const playerId = randomUUID();
    const { body } = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      const txRows = await connection.execute<{ id: string }[]>(
        "select id from wager_transactions where wallet_id = ?",
        [body.id],
      );
      interface LedgerRow {
        direction: string;
        money_amount: string;
        balance_before_amount: string;
        balance_after_amount: string;
        transaction_id: string;
      }
      const ledgerRows = await connection.execute<LedgerRow[]>(
        `select direction, money_amount, balance_before_amount, balance_after_amount, transaction_id
         from wallet_ledger_entries where wallet_id = ?`,
        [body.id],
      );

      expect(ledgerRows.length).toBe(1);
      expect(ledgerRows[0]?.direction).toBe("CREDIT");
      expect(ledgerRows[0]?.money_amount).toBe("1000.00");
      expect(ledgerRows[0]?.balance_before_amount).toBe("0.00");
      expect(ledgerRows[0]?.balance_after_amount).toBe("1000.00");
      expect(ledgerRows[0]?.transaction_id).toBe(txRows[0]?.id ?? "");
    } finally {
      await deleteWalletCascade(body.id);
    }
  });

  test(
    "two concurrent POST /wallets for the same playerId and currency leave exactly one wallet persisted",
    async () => {
      const playerId = randomUUID();
      const payload: CreateWalletBody = { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } };

      const [first, second] = await Promise.all([postWallet(payload), postWallet(payload)]);
      const winner = first.status === 201 ? first.body : second.body;

      try {
        expect([first.status, second.status].sort()).toEqual([201, 409]);
        expect(await countWhere("wallets", "player_id", playerId)).toBe(1);
        expect(await countWhere("wager_transactions", "wallet_id", winner.id)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "wallet_id", winner.id)).toBe(1);
      } finally {
        await deleteWalletCascade(winner.id);
      }
    },
    10_000,
  );
});

describe("POST /wallets - wallet duplicada", () => {
  test("a second sequential POST /wallets for the same playerId and currency returns 409 and leaves the first wallet unchanged", async () => {
    const playerId = randomUUID();
    const first = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      expect(first.status).toBe(201);

      const second = await postWallet({ playerId, initialBalance: { amount: "500.00", currency: "BRL" } });
      expect(second.status).toBe(409);

      const fetched = await getWallet(first.body.id);
      expect(fetched.status).toBe(200);
      expect(fetched.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(first.body.id);
    }
  });
});

describe("GET /wallets/:walletId", () => {
  test("GET /wallets/:walletId returns 200 with the persisted state", async () => {
    const playerId = randomUUID();
    const created = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      const { status, body } = await getWallet(created.body.id);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: created.body.id,
        playerId,
        balance: { amount: "1000.00", currency: "BRL" },
        version: 1,
      });
    } finally {
      await deleteWalletCascade(created.body.id);
    }
  });

  test("GET /wallets/:walletId with an unknown id returns 404", async () => {
    const { status } = await getWallet(randomUUID());
    expect(status).toBe(404);
  });

  test("GET /wallets/:walletId with a malformed non-UUID id returns 400, never 500", async () => {
    const { status } = await getWallet("not-a-uuid");
    expect(status).toBe(400);
  });
});

describe("POST /wallets - payload inválido", () => {
  test("POST /wallets with an invalid payload returns 400 and creates no wallet", async () => {
    const examples: CreateWalletBody[] = [
      { playerId: randomUUID(), initialBalance: { amount: "10.00", currency: "BR" } },
      { playerId: randomUUID(), initialBalance: { amount: "10.555", currency: "BRL" } },
      { playerId: "", initialBalance: { amount: "10.00", currency: "BRL" } },
    ];

    for (const payload of examples) {
      const { status } = await postWallet(payload);
      expect(status).toBe(400);
    }

    for (const payload of examples) {
      expect(await countWhere("wallets", "player_id", payload.playerId)).toBe(0);
    }
  });
});

describe("Contrato de resposta", () => {
  test("POST /wallets and GET /wallets/:walletId response bodies contain exactly id, playerId, balance and version", async () => {
    const playerId = randomUUID();
    const created = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      expect(Object.keys(created.body).sort()).toEqual(["balance", "id", "playerId", "version"]);
      expect(Object.keys(created.body.balance).sort()).toEqual(["amount", "currency"]);

      const fetched = await getWallet(created.body.id);
      expect(Object.keys(fetched.body).sort()).toEqual(["balance", "id", "playerId", "version"]);
      expect(Object.keys(fetched.body.balance).sort()).toEqual(["amount", "currency"]);
    } finally {
      await deleteWalletCascade(created.body.id);
    }
  });
});
