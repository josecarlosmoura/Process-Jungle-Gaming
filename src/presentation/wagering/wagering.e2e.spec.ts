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

describe("POST /wagering/transactions - conflito de idempotência (payload diferente)", () => {
  test("reusing the Idempotency-Key of an already PROCESSED BET with a different money.amount returns 409 IDEMPOTENCY_CONFLICT, persists no second WagerTransaction and does not debit again", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const firstPayload = betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } });
    try {
      const first = await postBet(firstPayload, idempotencyKey);
      expect(first.status).toBe(201);

      const conflicting = await postBet({ ...firstPayload, money: { amount: "999.00", currency: "BRL" } }, idempotencyKey);

      expect(conflicting.status).toBe(409);
      expect(conflicting.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
      expect(conflicting.body.transactionId).toBeUndefined();
      expect(await countWhere("wager_transactions", "idempotency_key", idempotencyKey)).toBe(1);

      const rows = await connection.execute<{ balance_amount: string }[]>(
        "select balance_amount from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("975.00");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("reusing the Idempotency-Key of an already PROCESSED BET with a different gameId also returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const firstPayload = betPayload(walletId, { gameId: "fortune-chimp", money: { amount: "25.00", currency: "BRL" } });
    try {
      const first = await postBet(firstPayload, idempotencyKey);
      expect(first.status).toBe(201);

      const conflicting = await postBet({ ...firstPayload, gameId: "another-game" }, idempotencyKey);

      expect(conflicting.status).toBe(409);
      expect(conflicting.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
      expect(await countWhere("wager_transactions", "idempotency_key", idempotencyKey)).toBe(1);

      const rows = await connection.execute<{ balance_amount: string }[]>(
        "select balance_amount from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("975.00");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - conflito de idempotência contra uma transação REJECTED", () => {
  test("reusing the Idempotency-Key of an already REJECTED BET with a different payload returns 409 IDEMPOTENCY_CONFLICT instead of replaying the REJECTED result", async () => {
    const walletId = await insertWallet("20.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const firstPayload = betPayload(walletId, { money: { amount: "20.01", currency: "BRL" } });
    try {
      const first = await postBet(firstPayload, idempotencyKey);
      expect(first.status).toBe(422);
      expect(first.body.status).toBe("REJECTED");
      expect(first.body.failureCode).toBe("INSUFFICIENT_FUNDS");

      const conflicting = await postBet({ ...firstPayload, money: { amount: "5.00", currency: "BRL" } }, idempotencyKey);

      expect(conflicting.status).toBe(409);
      expect(conflicting.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
      expect(conflicting.body.status).toBeUndefined();
      expect(await countWhere("wager_transactions", "idempotency_key", idempotencyKey)).toBe(1);
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

describe("POST /wagering/transactions - WIN sem referência", () => {
  test("POST /wagering/transactions for a new WIN without a reference returns 201 PROCESSED with the credited balance and idempotentReplay false", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "WIN", money: { amount: "50.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(status).toBe(201);
      expect(body.status).toBe("PROCESSED");
      expect(body.balance).toEqual({ amount: "1050.00", currency: "BRL" });
      expect(body.idempotentReplay).toBe(false);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - lançamento de ledger e version no crédito de WIN", () => {
  test("a WIN without a reference persists exactly one matching CREDIT ledger entry and increments the wallet version", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "WIN", money: { amount: "50.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(201);

      const rows = await connection.execute<
        { direction: string; money_amount: string; balance_before_amount: string; balance_after_amount: string; transaction_id: string }[]
      >(
        "select direction, money_amount, balance_before_amount, balance_after_amount, transaction_id from wallet_ledger_entries where wallet_id = ?",
        [walletId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.direction).toBe("CREDIT");
      expect(rows[0]?.money_amount).toBe("50.00");
      expect(rows[0]?.balance_before_amount).toBe("1000.00");
      expect(rows[0]?.balance_after_amount).toBe("1050.00");
      expect(rows[0]?.transaction_id).toBe(body.transactionId);

      const walletRows = await connection.execute<{ version: number }[]>("select version from wallets where id = ?", [walletId]);
      expect(walletRows[0]?.version).toBe(2);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - WIN com referência válida", () => {
  test("a WIN with a referenceExternalTransactionId pointing to a PROCESSED BET of the same provider, player, wallet, currency and round credits normally and persists reference_transaction_id", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const betExternalId = randomUUID();
      const bet = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: betExternalId,
          money: { amount: "25.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(bet.status).toBe(201);

      const win = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(win.status).toBe(201);
      expect(win.body.status).toBe("PROCESSED");
      expect(win.body.balance).toEqual({ amount: "1025.00", currency: "BRL" });

      const rows = await connection.execute<{ reference_transaction_id: string }[]>(
        "select reference_transaction_id from wager_transactions where id = ?",
        [win.body.transactionId],
      );
      expect(rows[0]?.reference_transaction_id).toBe(bet.body.transactionId ?? null);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - WIN com referência inválida", () => {
  test(
    "a WIN with an invalid reference is rejected with 422 REFERENCE_MISMATCH without crediting, over not-found, different round, still PENDING, already REJECTED and non-BET kind reference cases",
    async () => {
      const providerId = "provider-a";
      const playerId = randomUUID();
      const roundId = `round-${randomUUID()}`;

      async function expectReferenceMismatch(walletId: string, referenceExternalTransactionId: string, overrides: Partial<BetBody> = {}) {
        const before = await connection.execute<{ balance_amount: string }[]>("select balance_amount from wallets where id = ?", [
          walletId,
        ]);
        const { status, body } = await postBet(
          betPayload(walletId, {
            providerId,
            playerId,
            roundId,
            kind: "WIN",
            money: { amount: "50.00", currency: "BRL" },
            referenceExternalTransactionId,
            ...overrides,
          }),
          `provider-a:${randomUUID()}`,
        );
        expect(status).toBe(422);
        expect(body.status).toBe("REJECTED");
        expect(body.failureCode).toBe("REFERENCE_MISMATCH");
        const after = await connection.execute<{ balance_amount: string }[]>("select balance_amount from wallets where id = ?", [
          walletId,
        ]);
        expect(after[0]?.balance_amount).toBe(before[0]?.balance_amount);
      }

      // referência nunca existiu para esse provider
      let walletId = await insertWallet("1000.00");
      try {
        await expectReferenceMismatch(walletId, randomUUID());
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe, mas de outra rodada
      walletId = await insertWallet("1000.00");
      try {
        const betExternalId = randomUUID();
        await postBet(
          betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: betExternalId }),
          `provider-a:${randomUUID()}`,
        );
        await expectReferenceMismatch(walletId, betExternalId, { roundId: `round-${randomUUID()}` });
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe, mas ainda PENDING (nunca chegou a processar)
      walletId = await insertWallet("1000.00");
      try {
        const pendingExternalId = randomUUID();
        await connection.execute(
          `insert into wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
              round_id, game_id, kind, money_amount, money_currency)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', '25.00', 'BRL')`,
          [randomUUID(), providerId, pendingExternalId, `provider-a:${randomUUID()}`, "irrelevant-hash", walletId, playerId, roundId, "fortune-chimp"],
        );
        await expectReferenceMismatch(walletId, pendingExternalId);
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe, mas já REJECTED (saldo insuficiente)
      walletId = await insertWallet("10.00");
      try {
        const rejectedExternalId = randomUUID();
        const rejected = await postBet(
          betPayload(walletId, {
            providerId,
            playerId,
            roundId,
            externalTransactionId: rejectedExternalId,
            money: { amount: "20.00", currency: "BRL" },
          }),
          `provider-a:${randomUUID()}`,
        );
        expect(rejected.status).toBe(422);
        await expectReferenceMismatch(walletId, rejectedExternalId);
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe e está PROCESSED, mas não é uma BET (outra WIN)
      walletId = await insertWallet("1000.00");
      try {
        const winExternalId = randomUUID();
        const firstWin = await postBet(
          betPayload(walletId, {
            providerId,
            playerId,
            roundId,
            kind: "WIN",
            externalTransactionId: winExternalId,
            money: { amount: "10.00", currency: "BRL" },
          }),
          `provider-a:${randomUUID()}`,
        );
        expect(firstWin.status).toBe(201);
        await expectReferenceMismatch(walletId, winExternalId);
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe e está PROCESSED como BET, mas de outro playerId
      walletId = await insertWallet("1000.00");
      try {
        const betExternalId = randomUUID();
        await postBet(
          betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: betExternalId }),
          `provider-a:${randomUUID()}`,
        );
        await expectReferenceMismatch(walletId, betExternalId, { playerId: randomUUID() });
      } finally {
        await deleteWalletCascade(walletId);
      }

      // referência existe e está PROCESSED como BET do mesmo provider/externalId, mas em outra wallet
      {
        const betWalletId = await insertWallet("1000.00");
        const winWalletId = await insertWallet("1000.00");
        try {
          const betExternalId = randomUUID();
          await postBet(
            betPayload(betWalletId, { providerId, playerId, roundId, externalTransactionId: betExternalId }),
            `provider-a:${randomUUID()}`,
          );
          await expectReferenceMismatch(winWalletId, betExternalId);
        } finally {
          await deleteWalletCascade(betWalletId);
          await deleteWalletCascade(winWalletId);
        }
      }

      // referência existe e está PROCESSED como BET do mesmo grupo, mas em moeda diferente da WIN
      walletId = await insertWallet("1000.00", "BRL");
      try {
        const betExternalId = randomUUID();
        await postBet(
          betPayload(walletId, {
            providerId,
            playerId,
            roundId,
            externalTransactionId: betExternalId,
            money: { amount: "25.00", currency: "BRL" },
          }),
          `provider-a:${randomUUID()}`,
        );
        await expectReferenceMismatch(walletId, betExternalId, { money: { amount: "50.00", currency: "USD" } });
      } finally {
        await deleteWalletCascade(walletId);
      }
    },
    20_000,
  );
});

describe("POST /wagering/transactions - LOSS não move saldo", () => {
  test("a LOSS returns 201 PROCESSED, leaves the wallet balance and version unchanged, and persists no wallet_ledger_entries row", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "LOSS", money: { amount: "25.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(status).toBe(201);
      expect(body.status).toBe("PROCESSED");
      expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(body.idempotentReplay).toBe(false);
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);

      const rows = await connection.execute<{ balance_amount: string; version: number }[]>(
        "select balance_amount, version from wallets where id = ?",
        [walletId],
      );
      expect(rows[0]?.balance_amount).toBe("1000.00");
      expect(rows[0]?.version).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - LOSS com moeda divergente", () => {
  test("a LOSS whose money currency differs from the wallet currency returns 422 REJECTED with failureCode CURRENCY_MISMATCH, leaves the balance unchanged and persists no ledger entry", async () => {
    const walletId = await insertWallet("1000.00", "BRL");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "LOSS", money: { amount: "25.00", currency: "USD" } }),
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

describe("POST /wagering/transactions - WIN com moeda divergente", () => {
  test("a WIN whose money currency differs from the wallet currency returns 422 REJECTED with failureCode CURRENCY_MISMATCH, leaves the balance unchanged and persists no ledger entry", async () => {
    const walletId = await insertWallet("1000.00", "BRL");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "WIN", money: { amount: "25.00", currency: "USD" } }),
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

describe("POST /wagering/transactions - replay de WIN/LOSS PROCESSED", () => {
  test("repeating the Idempotency-Key of an already PROCESSED WIN or LOSS returns 200 with the same transactionId, status and balance, without applying the effect again", async () => {
    const kinds = ["WIN", "LOSS"] as const;

    for (const kind of kinds) {
      const walletId = await insertWallet("1000.00");
      const idempotencyKey = `provider-a:${randomUUID()}`;
      const payload = betPayload(walletId, { kind, money: { amount: "25.00", currency: "BRL" } });
      try {
        const first = await postBet(payload, idempotencyKey);
        expect(first.status).toBe(201);

        const second = await postBet(payload, idempotencyKey);

        expect(second.status).toBe(200);
        expect(second.body.transactionId).toBe(first.body.transactionId);
        expect(second.body.status).toBe("PROCESSED");
        expect(second.body.balance).toEqual(first.body.balance);
        expect(second.body.idempotentReplay).toBe(true);
      } finally {
        await deleteWalletCascade(walletId);
      }
    }
  });
});

describe("POST /wagering/transactions - replay de WIN REJECTED por REFERENCE_MISMATCH", () => {
  test("repeating the Idempotency-Key of a WIN already REJECTED by REFERENCE_MISMATCH returns 422 again with the same failureCode and idempotentReplay true", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const payload = betPayload(walletId, {
      kind: "WIN",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: randomUUID(),
    });
    try {
      const first = await postBet(payload, idempotencyKey);
      expect(first.status).toBe(422);
      expect(first.body.failureCode).toBe("REFERENCE_MISMATCH");

      const second = await postBet(payload, idempotencyKey);

      expect(second.status).toBe(422);
      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(second.body.status).toBe("REJECTED");
      expect(second.body.failureCode).toBe("REFERENCE_MISMATCH");
      expect(second.body.idempotentReplay).toBe(true);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - replay de LOSS após outra transação mover o saldo", () => {
  test("repeating the Idempotency-Key of an already PROCESSED LOSS returns the balance observed at that LOSS's own processing time, even after a later transaction changes the wallet's current balance", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const lossPayload = betPayload(walletId, { kind: "LOSS", money: { amount: "25.00", currency: "BRL" } });
    try {
      const first = await postBet(lossPayload, idempotencyKey);
      expect(first.status).toBe(201);
      expect(first.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const win = await postBet(
        betPayload(walletId, { kind: "WIN", money: { amount: "50.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);
      expect(win.body.balance).toEqual({ amount: "1050.00", currency: "BRL" });

      const replay = await postBet(lossPayload, idempotencyKey);

      expect(replay.status).toBe(200);
      expect(replay.body.transactionId).toBe(first.body.transactionId);
      expect(replay.body.status).toBe("PROCESSED");
      expect(replay.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(replay.body.idempotentReplay).toBe(true);
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

describe("POST /wagering/transactions - kind ainda não suportado (BET/WIN/LOSS implementados, REFUND/ROLLBACK não)", () => {
  test("POST /wagering/transactions with a kind outside BET/WIN/LOSS but still within the domain's known kinds returns 400 identifying the unsupported kind and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId, { kind: "REFUND" }), `provider-a:${randomUUID()}`);

      expect(status).toBe(400);
      expect(JSON.stringify(body.message)).toContain("REFUND");
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
