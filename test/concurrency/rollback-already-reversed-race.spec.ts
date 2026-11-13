import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado (decoracao de classe,
// antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do import dinamico
// de AppModule, nunca depois de um import estatico no topo do arquivo (mesmo padrao de
// test/concurrency/refund-already-reversed-race.spec.ts).
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
  PORT: "4323",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");

const PORT = 4323;
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

interface TransactionResponseBody {
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

async function postWagerTransaction(
  body: unknown,
  idempotencyKey: string,
): Promise<{ status: number; body: TransactionResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as TransactionResponseBody };
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

describe("corrida de ROLLBACK concorrente sobre a mesma referência", () => {
  test(
    "two concurrent ROLLBACK POSTs with different Idempotency-Keys referencing the same PROCESSED BET leave exactly one 201 PROCESSED and the other 422 REFERENCE_ALREADY_REVERSED, crediting the wallet back exactly once",
    async () => {
      const wallet = await createWallet("1000.00");
      const providerId = "provider-rollback-race";
      const playerId = randomUUID();
      const roundId = "round-rollback-race";
      const betExternalId = `bet-${randomUUID()}`;

      const bet = await postWagerTransaction(
        {
          providerId,
          externalTransactionId: betExternalId,
          playerId,
          walletId: wallet.id,
          roundId,
          gameId: "rollback-race-scenario",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:${betExternalId}`,
      );
      expect(bet.status).toBe(201);

      const rollbackRequestBody = {
        providerId,
        playerId,
        walletId: wallet.id,
        roundId,
        gameId: "rollback-race-scenario",
        kind: "ROLLBACK",
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: betExternalId,
      };

      try {
        const [first, second] = await Promise.all([
          postWagerTransaction(
            { ...rollbackRequestBody, externalTransactionId: `rollback-a-${randomUUID()}` },
            `${providerId}:rollback-a-${randomUUID()}`,
          ),
          postWagerTransaction(
            { ...rollbackRequestBody, externalTransactionId: `rollback-b-${randomUUID()}` },
            `${providerId}:rollback-b-${randomUUID()}`,
          ),
        ]);
        const responses = [first, second];

        const succeeded = responses.filter((response) => response.status === 201);
        const rejected = responses.filter((response) => response.status === 422);

        expect(succeeded.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(succeeded[0]?.body.status).toBe("PROCESSED");
        expect(rejected[0]?.body.status).toBe("REJECTED");
        expect(rejected[0]?.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [wallet.id],
        );
        expect(rows[0]?.balance_amount).toBe("1000.00");

        // 3, nao 2: POST /wallets com saldo inicial positivo ja grava sua propria OPENING
        // CREDIT (abertura da wallet) - as duas que esta corrida de fato exercita sao a DEBIT da
        // BET e a unica CREDIT do ROLLBACK vencedor.
        expect(await countWhere("wallet_ledger_entries", "wallet_id", wallet.id)).toBe(3);
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    10_000,
  );
});

describe("corrida de ROLLBACK concorrente perto do limite de saldo", () => {
  test(
    "two concurrent ROLLBACK POSTs reversing the same PROCESSED WIN, where the wallet balance only covers one reverse debit without going negative, leave exactly one 201 PROCESSED DEBIT and the other 422 (REFERENCE_ALREADY_REVERSED or REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE), balance never negative",
    async () => {
      const wallet = await createWallet("10.00");
      const providerId = "provider-rollback-race-balance";
      const playerId = randomUUID();
      const roundId = "round-rollback-race-balance";
      const winExternalId = `win-${randomUUID()}`;

      const win = await postWagerTransaction(
        {
          providerId,
          externalTransactionId: winExternalId,
          playerId,
          walletId: wallet.id,
          roundId,
          gameId: "rollback-race-balance-scenario",
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
        },
        `${providerId}:${winExternalId}`,
      );
      expect(win.status).toBe(201);
      // Saldo apos o WIN: 60.00 - uma unica reversao de 50.00 cabe (sobra 10.00), mas duas
      // reversoes concorrentes da mesma WIN nunca podem ambas debitar: a segunda, se chegar a
      // tentar, encontraria so 10.00 disponiveis para um debito de 50.00.
      expect(win.body.balance).toEqual({ amount: "60.00", currency: "BRL" });

      const rollbackRequestBody = {
        providerId,
        playerId,
        walletId: wallet.id,
        roundId,
        gameId: "rollback-race-balance-scenario",
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: winExternalId,
      };

      try {
        const [first, second] = await Promise.all([
          postWagerTransaction(
            { ...rollbackRequestBody, externalTransactionId: `rollback-a-${randomUUID()}` },
            `${providerId}:rollback-a-${randomUUID()}`,
          ),
          postWagerTransaction(
            { ...rollbackRequestBody, externalTransactionId: `rollback-b-${randomUUID()}` },
            `${providerId}:rollback-b-${randomUUID()}`,
          ),
        ]);
        const responses = [first, second];

        const succeeded = responses.filter((response) => response.status === 201);
        const rejected = responses.filter((response) => response.status === 422);

        expect(succeeded.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(succeeded[0]?.body.status).toBe("PROCESSED");
        expect(rejected[0]?.body.status).toBe("REJECTED");
        expect(["REFERENCE_ALREADY_REVERSED", "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE"]).toContain(
          rejected[0]?.body.failureCode,
        );

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [wallet.id],
        );
        // Exatamente uma reversao aplicada (DEBIT de 50.00 sobre os 60.00 do WIN) - nunca duas,
        // e nunca negativo.
        expect(rows[0]?.balance_amount).toBe("10.00");
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    10_000,
  );
});
