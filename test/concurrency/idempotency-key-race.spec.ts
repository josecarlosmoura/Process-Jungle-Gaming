import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado (decoracao de classe,
// antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do import dinamico
// de AppModule, nunca depois de um import estatico no topo do arquivo (mesmo padrao de
// test/concurrency/concurrent-bet.spec.ts).
Object.assign(process.env, {
  DB_HOST: "localhost",
  DB_PORT: "5440",
  DB_USER: "wagering",
  DB_PASSWORD: "wagering",
  DB_NAME: "wagering_test",
  LOCALSTACK_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  LEDGER_CURSOR_SECRET: "dev-only-ledger-cursor-secret-not-for-production",
  PORT: "4321",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");

const PORT = 4321;
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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(PORT);
});

afterAll(async () => {
  await app.close();
  await orm.close();
});

async function deleteWalletCascade(walletId: string): Promise<void> {
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
  await connection.execute("delete from wallets where id = ?", [walletId]);
}

interface MoneyBody {
  amount: string;
  currency: string;
}

interface WalletResponseBody {
  id: string;
  playerId: string;
  balance: MoneyBody;
  version: number;
}

interface BetResponseBody {
  transactionId?: string;
  status?: string;
  balance?: MoneyBody;
  idempotentReplay?: boolean;
  failureCode?: string;
}

async function createWallet(initialAmount: string, currency = "BRL"): Promise<WalletResponseBody> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount: initialAmount, currency },
    }),
  });
  const body = (await response.json()) as WalletResponseBody;
  if (response.status !== 201) {
    throw new Error(`POST /wallets failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

function betRequestBody(walletId: string, amount: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: "provider-idempotency-race",
    externalTransactionId: "dup-001",
    playerId: randomUUID(),
    walletId,
    roundId: "round-idempotency-race",
    gameId: "idempotency-race-scenario",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...overrides,
  };
}

async function postBet(
  body: unknown,
  idempotencyKey: string,
): Promise<{ status: number; body: BetResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as BetResponseBody };
}

describe("corrida de inserção na mesma Idempotency-Key - payload idêntico sob paralelismo real (50 réplicas)", () => {
  test(
    "50 identical parallel POSTs with the same Idempotency-Key and payload debit the wallet exactly once, with exactly one 201 and 49 replaying 200 responses sharing the same transactionId",
    async () => {
      const wallet = await createWallet("1000.00");
      const idempotencyKey = `provider-idempotency-race:${randomUUID()}`;
      const payload = betRequestBody(wallet.id, "10.00");
      try {
        const responses = await Promise.all(
          Array.from({ length: 50 }, () => postBet(payload, idempotencyKey)),
        );

        const created = responses.filter((response) => response.status === 201);
        const replayed = responses.filter((response) => response.status === 200);

        expect(created.length).toBe(1);
        expect(replayed.length).toBe(49);

        const transactionId = created[0]?.body.transactionId;
        expect(transactionId).toBeDefined();
        for (const response of responses) {
          expect(response.body.transactionId).toBe(transactionId);
        }
        for (const response of replayed) {
          expect(response.body.idempotentReplay).toBe(true);
        }
        expect(created[0]?.body.idempotentReplay).toBe(false);

        expect(await countWhere("wager_transactions", "idempotency_key", idempotencyKey)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "transaction_id", transactionId as string)).toBe(1);

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [wallet.id],
        );
        expect(rows[0]?.balance_amount).toBe("990.00");
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    30_000,
  );
});

describe("corrida de inserção na mesma Idempotency-Key - payload divergente sob paralelismo real", () => {
  test(
    "two concurrent POSTs with the same Idempotency-Key but different money.amount leave exactly one success and the other 409 IDEMPOTENCY_CONFLICT, never two debits",
    async () => {
      const wallet = await createWallet("1000.00");
      const idempotencyKey = `provider-idempotency-race:${randomUUID()}`;
      const payloadA = betRequestBody(wallet.id, "10.00");
      const payloadB = betRequestBody(wallet.id, "20.00");
      try {
        const [first, second] = await Promise.all([
          postBet(payloadA, idempotencyKey),
          postBet(payloadB, idempotencyKey),
        ]);
        const responses = [first, second];

        const succeeded = responses.filter((response) => response.status === 201);
        const conflicted = responses.filter((response) => response.status === 409);

        expect(succeeded.length).toBe(1);
        expect(conflicted.length).toBe(1);
        expect(conflicted[0]?.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
        expect(conflicted[0]?.body.transactionId).toBeUndefined();

        const winningTransactionId = succeeded[0]?.body.transactionId as string;
        expect(await countWhere("wager_transactions", "idempotency_key", idempotencyKey)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "transaction_id", winningTransactionId)).toBe(1);

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [wallet.id],
        );
        expect(rows[0]?.balance_amount).toBe(succeeded[0]?.body.balance?.amount);
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    10_000,
  );
});
