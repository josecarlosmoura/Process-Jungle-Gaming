import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado (decoracao de classe,
// antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do import dinamico
// de AppModule, nunca depois de um import estatico no topo do arquivo (mesmo padrao dos specs
// e2e em src/presentation/**).
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
  PORT: "4320",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

const PORT = 4320;
const baseUrl = `http://127.0.0.1:${PORT}`;
const ROUNDS = 30;

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

async function getWallet(walletId: string): Promise<WalletResponseBody> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}`);
  return (await response.json()) as WalletResponseBody;
}

async function postBet(walletId: string, amount: string, currency = "BRL"): Promise<{ status: number; body: BetResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `provider-concurrency:${randomUUID()}`,
    },
    body: JSON.stringify({
      providerId: "provider-concurrency",
      externalTransactionId: randomUUID(),
      playerId: randomUUID(),
      walletId,
      roundId: "round-concurrency",
      gameId: "concurrency-scenario",
      kind: "BET",
      money: { amount, currency },
    }),
  });
  return { status: response.status, body: (await response.json()) as BetResponseBody };
}

async function countDebitLedgerEntries(walletId: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    "select count(*) as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
    [walletId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function reconstructLedgerBalance(walletId: string, currency: string) {
  const rows = await connection.execute<{ direction: string; money_amount: string; money_currency: string }[]>(
    "select direction, money_amount, money_currency from wallet_ledger_entries where wallet_id = ?",
    [walletId],
  );
  return rows.reduce((balance, row) => {
    const entry = Money.from({ amount: row.money_amount, currency: row.money_currency });
    return row.direction === "CREDIT" ? balance.add(entry) : balance.subtract(entry);
  }, Money.zero(currency));
}

async function runConcurrentBetRound(): Promise<void> {
  const wallet = await createWallet("100.00");
  try {
    const [first, second] = await Promise.all([postBet(wallet.id, "80.00"), postBet(wallet.id, "80.00")]);
    const results = [first, second];

    const processed = results.filter((result) => result.body.status === "PROCESSED");
    const rejected = results.filter((result) => result.body.status === "REJECTED");

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(processed[0]?.status).toBe(201);
    expect(rejected[0]?.status).toBe(422);
    expect(rejected[0]?.body.failureCode).toBe("INSUFFICIENT_FUNDS");

    const finalWallet = await getWallet(wallet.id);
    expect(finalWallet.balance).toEqual({ amount: "20.00", currency: "BRL" });

    expect(await countDebitLedgerEntries(wallet.id)).toBe(1);

    const reconstructed = await reconstructLedgerBalance(wallet.id, finalWallet.balance.currency);
    expect(reconstructed.toJSON()).toEqual(finalWallet.balance);
  } finally {
    await deleteWalletCascade(wallet.id);
  }
}

describe("cenário obrigatório de concorrência - duas BETs de 80.00 BRL disputando uma wallet com 100.00 BRL", () => {
  test(
    "two parallel BETs of 80.00 BRL against a wallet with 100.00 BRL leave exactly one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, final balance 20.00 BRL and exactly one DEBIT ledger entry matching wallet.balance, repeated over 30 fresh-wallet rounds",
    async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        await runConcurrentBetRound();
      }
    },
    60_000,
  );
});
