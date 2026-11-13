import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado (decoracao de classe,
// antes do corpo deste teste rodar) - por isso o env precisa ser setado antes do import dinamico
// de WageringModule, nunca depois de um import estatico no topo do arquivo (mesmo padrao de
// wallets.e2e.spec.ts).
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
  PORT: "4316",
});

const { WageringModule } = await import("./wagering.module");
const { validateEnv } = await import("../../infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../infrastructure/database/mikro-orm.config");
const { Money } = await import("../../domain/money");
const { computeWagerTransactionPayloadHash } = await import("../../application/use-cases/wager-transaction-payload-hash");

const PORT = 4316;
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
  const moduleRef = await Test.createTestingModule({ imports: [WageringModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(PORT);
});

afterAll(async () => {
  await app.close();
  await orm.close();
});

async function insertWallet(balanceAmount: string, currency = "BRL"): Promise<string> {
  const id = randomUUID();
  await connection.execute(
    `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [id, randomUUID(), currency, balanceAmount],
  );
  return id;
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

interface MoneyBody {
  amount: string;
  currency: string;
}

interface BetBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyBody;
  referenceExternalTransactionId?: string;
}

interface ResponseBody {
  transactionId?: string;
  status?: string;
  balance?: MoneyBody;
  idempotentReplay?: boolean;
  failureCode?: string;
  message?: unknown;
}

function betPayload(walletId: string, overrides: Partial<BetBody> = {}): BetBody {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

async function postBet(
  body: unknown,
  idempotencyKey: string | null,
): Promise<{ status: number; body: ResponseBody }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey !== null) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ResponseBody };
}

describe("POST /wagering/transactions - header Idempotency-Key ausente", () => {
  test("POST /wagering/transactions without the Idempotency-Key header returns 400 and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status } = await postBet(betPayload(walletId), null);

      expect(status).toBe(400);
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - BET com saldo suficiente", () => {
  test("POST /wagering/transactions for a new BET with sufficient balance returns 201 PROCESSED with the debited balance and idempotentReplay false", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(status).toBe(201);
      expect(body.status).toBe("PROCESSED");
      expect(body.balance).toEqual({ amount: "975.00", currency: "BRL" });
      expect(body.idempotentReplay).toBe(false);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - lançamento de ledger no limite do saldo", () => {
  test("a BET processed at or just below the available balance persists exactly one matching DEBIT ledger entry", async () => {
    const cases = [
      { initial: "50.00", bet: "50.00", expectedBalance: "0.00" },
      { initial: "50.00", bet: "49.99", expectedBalance: "0.01" },
    ];

    for (const { initial, bet, expectedBalance } of cases) {
      const walletId = await insertWallet(initial);
      try {
        const { status, body } = await postBet(
          betPayload(walletId, { money: { amount: bet, currency: "BRL" } }),
          `provider-a:${randomUUID()}`,
        );
        expect(status).toBe(201);
        expect(body.balance).toEqual({ amount: expectedBalance, currency: "BRL" });

        const rows = await connection.execute<
          { direction: string; money_amount: string; balance_before_amount: string; balance_after_amount: string; transaction_id: string }[]
        >(
          "select direction, money_amount, balance_before_amount, balance_after_amount, transaction_id from wallet_ledger_entries where wallet_id = ?",
          [walletId],
        );

        expect(rows.length).toBe(1);
        expect(rows[0]?.direction).toBe("DEBIT");
        expect(rows[0]?.money_amount).toBe(bet);
        expect(rows[0]?.balance_before_amount).toBe(initial);
        expect(rows[0]?.balance_after_amount).toBe(expectedBalance);
        expect(rows[0]?.transaction_id).toBe(body.transactionId);
      } finally {
        await deleteWalletCascade(walletId);
      }
    }
  });
});

describe("POST /wagering/transactions - BET com saldo insuficiente", () => {
  test("a BET greater than the available balance returns 422 REJECTED with failureCode INSUFFICIENT_FUNDS, leaves the balance unchanged and persists no ledger entry", async () => {
    const walletId = await insertWallet("20.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { money: { amount: "20.01", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(status).toBe(422);
      expect(body.status).toBe("REJECTED");
      expect(body.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(body.balance).toEqual({ amount: "20.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);

      const rows = await connection.execute<{ balance_amount: string }[]>(
        "select balance_amount from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("20.00");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - replay de uma BET PROCESSED", () => {
  test("repeating the Idempotency-Key of an already PROCESSED BET returns 200 with the same transactionId, status, balance and idempotentReplay true, without debiting again", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const payload = betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } });
    try {
      const first = await postBet(payload, idempotencyKey);
      expect(first.status).toBe(201);

      const second = await postBet(payload, idempotencyKey);

      expect(second.status).toBe(200);
      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(second.body.status).toBe("PROCESSED");
      expect(second.body.balance).toEqual(first.body.balance);
      expect(second.body.idempotentReplay).toBe(true);

      const rows = await connection.execute<{ balance_amount: string }[]>(
        "select balance_amount from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("975.00");
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - replay de uma BET REJECTED", () => {
  test("repeating the Idempotency-Key of an already REJECTED BET returns 422 again with the same failureCode and idempotentReplay true", async () => {
    const walletId = await insertWallet("20.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const payload = betPayload(walletId, { money: { amount: "20.01", currency: "BRL" } });
    try {
      const first = await postBet(payload, idempotencyKey);
      expect(first.status).toBe(422);

      const second = await postBet(payload, idempotencyKey);

      expect(second.status).toBe(422);
      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(second.body.status).toBe("REJECTED");
      expect(second.body.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(second.body.idempotentReplay).toBe(true);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - corrida de inserção na mesma Idempotency-Key", () => {
  test(
    "two concurrent POST /wagering/transactions with the same Idempotency-Key and walletId persist exactly one WagerTransaction and debit the balance at most once",
    async () => {
      const walletId = await insertWallet("1000.00");
      const idempotencyKey = `provider-a:${randomUUID()}`;
      const payload = betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } });
      try {
        const [first, second] = await Promise.all([postBet(payload, idempotencyKey), postBet(payload, idempotencyKey)]);

        expect([first.status, second.status].sort()).toEqual([200, 201]);
        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(1);
        expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [walletId],
        );
        expect(rows[0]?.balance_amount).toBe("975.00");
      } finally {
        await deleteWalletCascade(walletId);
      }
    },
    10_000,
  );
});

describe("POST /wagering/transactions - moeda divergente", () => {
  test("a BET whose money currency differs from the wallet currency returns 422 REJECTED with failureCode CURRENCY_MISMATCH, leaves the balance unchanged and persists no ledger entry", async () => {
    const walletId = await insertWallet("1000.00", "BRL");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { money: { amount: "25.00", currency: "USD" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(status).toBe(422);
      expect(body.status).toBe("REJECTED");
      expect(body.failureCode).toBe("CURRENCY_MISMATCH");
      expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - walletId inexistente", () => {
  test("POST /wagering/transactions for an unknown walletId returns 404 and persists no WagerTransaction", async () => {
    const walletId = randomUUID();

    const { status } = await postBet(betPayload(walletId), `provider-a:${randomUUID()}`);

    expect(status).toBe(404);
    expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
  });
});

describe("POST /wagering/transactions - kind diferente de BET", () => {
  test("POST /wagering/transactions with a kind other than BET returns 400 identifying the unsupported kind and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId, { kind: "WIN" }), `provider-a:${randomUUID()}`);

      expect(status).toBe(400);
      expect(JSON.stringify(body.message)).toContain("WIN");
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("POST /wagering/transactions with a kind outside the domain's known set also identifies the received value", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId, { kind: "DEPOSIT" }), `provider-a:${randomUUID()}`);

      expect(status).toBe(400);
      expect(JSON.stringify(body.message)).toContain("DEPOSIT");
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - payload malformado", () => {
  test("POST /wagering/transactions with a malformed body returns 400 and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const base = betPayload(walletId);
      const examples: unknown[] = [
        { ...base, gameId: undefined },
        { ...base, money: { amount: "25.555", currency: "BRL" } },
        { ...base, money: { amount: "25.00", currency: "br" } },
        { ...base, walletId: "not-a-uuid" },
      ];

      for (const example of examples) {
        const { status } = await postBet(example, `provider-a:${randomUUID()}`);
        expect(status).toBe(400);
      }
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - payload_hash persistido", () => {
  test("POST /wagering/transactions for a new BET persists payload_hash equal to computeWagerTransactionPayloadHash of the same business fields", async () => {
    const walletId = await insertWallet("1000.00");
    const payload = betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } });
    try {
      const { body } = await postBet(payload, `provider-a:${randomUUID()}`);

      const expectedHash = computeWagerTransactionPayloadHash({
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        playerId: payload.playerId,
        walletId: payload.walletId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: "BET",
        money: Money.from(payload.money),
      });

      const rows = await connection.execute<{ payload_hash: string }[]>(
        "select payload_hash from wager_transactions where id = ?",
        [body.transactionId],
      );
      expect(rows[0]?.payload_hash).toBe(expectedHash);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - lock da wallet não obtido em 5s", () => {
  test(
    "a BET on a wallet locked by another transaction for longer than the lock_timeout returns 503 with failureCode INTERNAL_ERROR, persists no WagerTransaction and leaves the balance unchanged",
    async () => {
      const walletId = await insertWallet("1000.00");
      const trx = await connection.begin();
      try {
        await connection.execute("select id from wallets where id = ? for update", [walletId], "get", trx);

        const startedAt = Date.now();
        const { status, body } = await postBet(betPayload(walletId), `provider-a:${randomUUID()}`);
        const elapsedMs = Date.now() - startedAt;

        expect(status).toBe(503);
        expect(body.failureCode).toBe("INTERNAL_ERROR");
        expect(body.transactionId).toBeUndefined();
        expect(elapsedMs).toBeGreaterThan(4_000);
        expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [walletId],
        );
        expect(rows[0]?.balance_amount).toBe("1000.00");
      } finally {
        await connection.rollback(trx);
        await deleteWalletCascade(walletId);
      }
    },
    15_000,
  );
});
