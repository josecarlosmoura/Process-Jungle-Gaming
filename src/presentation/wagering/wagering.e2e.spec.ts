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
  await connection.execute("delete from outbox_messages where aggregate_id = ?", [walletId]);
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
  await connection.execute("delete from wallets where id = ?", [walletId]);
}

async function outboxPayloadsFor(walletId: string, eventType: string): Promise<Record<string, unknown>[]> {
  const rows = await connection.execute<{ payload: Record<string, unknown> }[]>(
    "select payload from outbox_messages where aggregate_id = ? and event_type = ? order by occurred_at asc",
    [walletId, eventType],
  );
  return rows.map((row) => row.payload);
}

// Filtra por transactionId dentro do payload (não só por wallet) - necessário sempre que o
// cenário tem mais de uma WagerTransaction na mesma wallet (ex.: a BET original que uma
// REFUND/ROLLBACK/WIN referencia), para a contagem não incluir os eventos da transação referenciada.
async function outboxEventTypesForTransaction(transactionId: string): Promise<string[]> {
  const rows = await connection.execute<{ event_type: string }[]>(
    `select event_type from outbox_messages
     where payload -> 'data' ->> 'transactionId' = ?
     order by occurred_at asc, event_type asc`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

interface PendingReferenceMetadata {
  attempts: number | null;
  nextAttemptAt: Date | null;
}

async function pendingReferenceMetadataFor(transactionId: string): Promise<PendingReferenceMetadata> {
  const rows = await connection.execute<{ attempts: number | null; next_attempt_at: string | null }[]>(
    "select attempts, next_attempt_at from wager_transactions where id = ?",
    [transactionId],
  );
  const row = rows[0];
  // connection.execute() devolve a linha crua do driver, sem a hidratacao de tipos do ORM -
  // next_attempt_at chega como string ISO (timestamptz), nunca como Date.
  return {
    attempts: row?.attempts ?? null,
    nextAttemptAt: row?.next_attempt_at ? new Date(row.next_attempt_at) : null,
  };
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

describe("POST /wagering/transactions - REFUND credita de volta", () => {
  test("a REFUND referencing a PROCESSED BET of the same provider, player, wallet, currency and round with the exact same amount credits the wallet back, persists one CREDIT wallet_ledger_entries row and reference_transaction_id pointing to the BET", async () => {
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
      expect(bet.body.balance).toEqual({ amount: "975.00", currency: "BRL" });

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(201);
      expect(refund.body.status).toBe("PROCESSED");
      expect(refund.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const rows = await connection.execute<{ reference_transaction_id: string; direction: string }[]>(
        `select wt.reference_transaction_id, wle.direction
         from wager_transactions wt
         join wallet_ledger_entries wle on wle.transaction_id = wt.id
         where wt.id = ?`,
        [refund.body.transactionId],
      );
      expect(rows[0]?.reference_transaction_id).toBe(bet.body.transactionId ?? null);
      expect(rows[0]?.direction).toBe("CREDIT");
      expect(await countWhere("wallet_ledger_entries", "transaction_id", refund.body.transactionId as string)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND com valor divergente", () => {
  test("a REFUND with a money.amount different from the referenced BET is rejected with 422 REFERENCE_AMOUNT_MISMATCH without crediting", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "30.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(422);
      expect(refund.body.status).toBe("REJECTED");
      expect(refund.body.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
      expect(refund.body.balance).toEqual({ amount: "975.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - segundo REFUND sobre a mesma BET", () => {
  test("a second REFUND over the same BET is rejected with 422 REFERENCE_ALREADY_REVERSED without crediting again", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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
      const firstRefund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(firstRefund.status).toBe(201);

      const secondRefund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(secondRefund.status).toBe(422);
      expect(secondRefund.body.status).toBe("REJECTED");
      expect(secondRefund.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
      expect(secondRefund.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(2);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND referenciando kind errado", () => {
  test("a REFUND referencing a WIN instead of a BET is rejected with 422 REFERENCE_MISMATCH without crediting", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const winExternalId = randomUUID();
      const win = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "WIN",
          externalTransactionId: winExternalId,
          money: { amount: "25.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: winExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(422);
      expect(refund.body.status).toBe("REJECTED");
      expect(refund.body.failureCode).toBe("REFERENCE_MISMATCH");
      expect(refund.body.balance).toEqual({ amount: "1025.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND referenciando BET rejeitada", () => {
  test("a REFUND referencing a BET that already ended REJECTED is rejected with 422 REFERENCE_NOT_FOUND without waiting as PENDING_REFERENCE", async () => {
    const walletId = await insertWallet("10.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const rejectedExternalId = randomUUID();
      const rejectedBet = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: rejectedExternalId,
          money: { amount: "20.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(rejectedBet.status).toBe(422);
      expect(rejectedBet.body.status).toBe("REJECTED");

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: rejectedExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(422);
      expect(refund.body.status).toBe("REJECTED");
      expect(refund.body.failureCode).toBe("REFERENCE_NOT_FOUND");
      expect(refund.body.balance).toEqual({ amount: "10.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND referenciando outro player", () => {
  test("a REFUND referencing a BET of another playerId is rejected with 422 REFERENCE_MISMATCH without crediting", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId: randomUUID(),
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(422);
      expect(refund.body.status).toBe("REJECTED");
      expect(refund.body.failureCode).toBe("REFERENCE_MISMATCH");
      expect(refund.body.balance).toEqual({ amount: "975.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND com referência inexistente", () => {
  test("a REFUND referencing an externalTransactionId that does not exist yet returns 202 Accepted with status PENDING_REFERENCE, attempts 0 and next_attempt_at in the near future, without crediting", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const beforeSubmit = Date.now();
      const refund = await postBet(
        betPayload(walletId, {
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: randomUUID(),
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(202);
      expect(refund.body.status).toBe("PENDING_REFERENCE");
      expect(refund.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);

      const metadata = await pendingReferenceMetadataFor(refund.body.transactionId as string);
      expect(metadata.attempts).toBe(0);
      expect(metadata.nextAttemptAt).not.toBeNull();
      expect((metadata.nextAttemptAt as Date).getTime()).toBeGreaterThan(beforeSubmit);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND com referência ainda PENDING", () => {
  test("a REFUND referencing a BET that is still PENDING returns 202 Accepted with status PENDING_REFERENCE, same as a reference that does not exist at all", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const pendingExternalId = randomUUID();
      await connection.execute(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, money_amount, money_currency)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', '25.00', 'BRL')`,
        [randomUUID(), providerId, pendingExternalId, `provider-a:${randomUUID()}`, "irrelevant-hash", walletId, playerId, roundId, "fortune-chimp"],
      );

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: pendingExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(refund.status).toBe(202);
      expect(refund.body.status).toBe("PENDING_REFERENCE");
      expect(refund.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - replay de REFUND PENDING_REFERENCE", () => {
  test("replaying a REFUND still PENDING_REFERENCE with the same Idempotency-Key returns 202 Accepted again, idempotentReplay true, without crediting", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const refundPayload = betPayload(walletId, {
      kind: "REFUND",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: randomUUID(),
    });
    try {
      const first = await postBet(refundPayload, idempotencyKey);
      expect(first.status).toBe(202);
      expect(first.body.idempotentReplay).toBe(false);

      const replay = await postBet(refundPayload, idempotencyKey);

      expect(replay.status).toBe(202);
      expect(replay.body.status).toBe("PENDING_REFERENCE");
      expect(replay.body.transactionId).toBe(first.body.transactionId);
      expect(replay.body.idempotentReplay).toBe(true);
      expect(replay.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("replaying a REFUND still PENDING_REFERENCE with the same Idempotency-Key keeps attempts and next_attempt_at unchanged, without creating a second attempt", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const refundPayload = betPayload(walletId, {
      kind: "REFUND",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: randomUUID(),
    });
    try {
      const first = await postBet(refundPayload, idempotencyKey);
      const transactionId = first.body.transactionId as string;
      const original = await pendingReferenceMetadataFor(transactionId);

      const replay = await postBet(refundPayload, idempotencyKey);

      expect(replay.status).toBe(202);
      expect(replay.body.idempotentReplay).toBe(true);
      const afterReplay = await pendingReferenceMetadataFor(transactionId);
      expect(afterReplay.attempts).toBe(original.attempts);
      expect(afterReplay.nextAttemptAt).toEqual(original.nextAttemptAt);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - REFUND sem referência no payload", () => {
  test("POST /wagering/transactions with kind REFUND and no referenceExternalTransactionId returns 400 and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId, { kind: "REFUND" }), `provider-a:${randomUUID()}`);

      expect(status).toBe(400);
      expect(JSON.stringify(body.message)).toContain("referenceExternalTransactionId");
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK credita de volta (reverte BET)", () => {
  test("a ROLLBACK referencing a PROCESSED BET of the same provider, player, wallet, currency and round with the exact same amount credits the wallet back, persists one CREDIT wallet_ledger_entries row and reference_transaction_id pointing to the BET", async () => {
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
      expect(bet.body.balance).toEqual({ amount: "975.00", currency: "BRL" });

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(201);
      expect(rollback.body.status).toBe("PROCESSED");
      expect(rollback.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const rows = await connection.execute<{ reference_transaction_id: string; direction: string }[]>(
        `select wt.reference_transaction_id, wle.direction
         from wager_transactions wt
         join wallet_ledger_entries wle on wle.transaction_id = wt.id
         where wt.id = ?`,
        [rollback.body.transactionId],
      );
      expect(rows[0]?.reference_transaction_id).toBe(bet.body.transactionId ?? null);
      expect(rows[0]?.direction).toBe("CREDIT");
      expect(await countWhere("wallet_ledger_entries", "transaction_id", rollback.body.transactionId as string)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK debita de volta (reverte WIN)", () => {
  test("a ROLLBACK referencing a PROCESSED WIN of the same provider, player, wallet, currency and round, with enough balance for the reverse debit, debits the wallet, persists one DEBIT wallet_ledger_entries row and reference_transaction_id pointing to the WIN", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const winExternalId = randomUUID();
      const win = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: winExternalId,
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);
      expect(win.body.balance).toEqual({ amount: "1050.00", currency: "BRL" });

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: winExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(201);
      expect(rollback.body.status).toBe("PROCESSED");
      expect(rollback.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const rows = await connection.execute<{ reference_transaction_id: string; direction: string }[]>(
        `select wt.reference_transaction_id, wle.direction
         from wager_transactions wt
         join wallet_ledger_entries wle on wle.transaction_id = wt.id
         where wt.id = ?`,
        [rollback.body.transactionId],
      );
      expect(rows[0]?.reference_transaction_id).toBe(win.body.transactionId ?? null);
      expect(rows[0]?.direction).toBe("DEBIT");
      expect(await countWhere("wallet_ledger_entries", "transaction_id", rollback.body.transactionId as string)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK de WIN levaria saldo a negativo", () => {
  test("a ROLLBACK referencing a PROCESSED WIN whose reverse debit exceeds the current balance is rejected with 422 REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE, balance and ledger untouched", async () => {
    const walletId = await insertWallet("10.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const winExternalId = randomUUID();
      const win = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: winExternalId,
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);
      expect(win.body.balance).toEqual({ amount: "60.00", currency: "BRL" });

      // Esvazia quase todo o saldo depois do WIN, deixando so 5.00 - menor que os 50.00 que o
      // ROLLBACK precisaria debitar de volta.
      const bet = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          money: { amount: "55.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(bet.status).toBe(201);
      expect(bet.body.balance).toEqual({ amount: "5.00", currency: "BRL" });

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: winExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(422);
      expect(rollback.body.status).toBe("REJECTED");
      expect(rollback.body.failureCode).toBe("REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE");
      expect(rollback.body.balance).toEqual({ amount: "5.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(2);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - BET sem saldo", () => {
  test("a BET with insufficient wallet balance is rejected with 422 INSUFFICIENT_FUNDS, distinct from a ROLLBACK's REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE", async () => {
    const walletId = await insertWallet("10.00");
    try {
      const bet = await postBet(
        betPayload(walletId, { money: { amount: "20.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );

      expect(bet.status).toBe(422);
      expect(bet.body.status).toBe("REJECTED");
      expect(bet.body.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(bet.body.balance).toEqual({ amount: "10.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - segundo ROLLBACK sobre a mesma referência", () => {
  test("a second ROLLBACK over the same reference is rejected with 422 REFERENCE_ALREADY_REVERSED without applying the effect again", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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
      const firstRollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(firstRollback.status).toBe(201);

      const secondRollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(secondRollback.status).toBe(422);
      expect(secondRollback.body.status).toBe("REJECTED");
      expect(secondRollback.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
      expect(secondRollback.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(2);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK referenciando LOSS", () => {
  test("a ROLLBACK referencing a LOSS is rejected with 422 REFERENCE_MISMATCH without applying any effect", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const lossExternalId = randomUUID();
      const loss = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: lossExternalId,
          kind: "LOSS",
          money: { amount: "10.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(loss.status).toBe(201);
      expect(loss.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "10.00", currency: "BRL" },
          referenceExternalTransactionId: lossExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(422);
      expect(rollback.body.status).toBe("REJECTED");
      expect(rollback.body.failureCode).toBe("REFERENCE_MISMATCH");
      expect(rollback.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK com valor divergente", () => {
  test("a ROLLBACK with a money.amount different from the referenced transaction is rejected with 422 REFERENCE_AMOUNT_MISMATCH without applying any effect", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "30.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(422);
      expect(rollback.body.status).toBe("REJECTED");
      expect(rollback.body.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
      expect(rollback.body.balance).toEqual({ amount: "975.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK referenciando transação rejeitada", () => {
  test("a ROLLBACK referencing a transaction that already ended REJECTED is rejected with 422 REFERENCE_NOT_FOUND without waiting as PENDING_REFERENCE", async () => {
    const walletId = await insertWallet("10.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const rejectedExternalId = randomUUID();
      const rejectedBet = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: rejectedExternalId,
          money: { amount: "20.00", currency: "BRL" },
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(rejectedBet.status).toBe(422);
      expect(rejectedBet.body.status).toBe("REJECTED");

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "20.00", currency: "BRL" },
          referenceExternalTransactionId: rejectedExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(422);
      expect(rollback.body.status).toBe("REJECTED");
      expect(rollback.body.failureCode).toBe("REFERENCE_NOT_FOUND");
      expect(rollback.body.balance).toEqual({ amount: "10.00", currency: "BRL" });
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK com referência inexistente", () => {
  test("a ROLLBACK referencing an externalTransactionId that does not exist yet returns 202 Accepted with status PENDING_REFERENCE, attempts 0 and next_attempt_at in the near future, without applying any effect", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const beforeSubmit = Date.now();
      const rollback = await postBet(
        betPayload(walletId, {
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: randomUUID(),
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(202);
      expect(rollback.body.status).toBe("PENDING_REFERENCE");
      expect(rollback.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
      expect(await countWhere("wallet_ledger_entries", "wallet_id", walletId)).toBe(0);

      const metadata = await pendingReferenceMetadataFor(rollback.body.transactionId as string);
      expect(metadata.attempts).toBe(0);
      expect(metadata.nextAttemptAt).not.toBeNull();
      expect((metadata.nextAttemptAt as Date).getTime()).toBeGreaterThan(beforeSubmit);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK reverte REFUND", () => {
  test("a ROLLBACK referencing a PROCESSED REFUND debits the wallet, persists one DEBIT wallet_ledger_entries row and reference_transaction_id pointing to the REFUND", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
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

      const refundExternalId = randomUUID();
      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          externalTransactionId: refundExternalId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(refund.status).toBe(201);
      expect(refund.body.balance).toEqual({ amount: "1000.00", currency: "BRL" });

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: refundExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );

      expect(rollback.status).toBe(201);
      expect(rollback.body.status).toBe("PROCESSED");
      expect(rollback.body.balance).toEqual({ amount: "975.00", currency: "BRL" });

      const rows = await connection.execute<{ reference_transaction_id: string; direction: string }[]>(
        `select wt.reference_transaction_id, wle.direction
         from wager_transactions wt
         join wallet_ledger_entries wle on wle.transaction_id = wt.id
         where wt.id = ?`,
        [rollback.body.transactionId],
      );
      expect(rows[0]?.reference_transaction_id).toBe(refund.body.transactionId ?? null);
      expect(rows[0]?.direction).toBe("DEBIT");
      expect(await countWhere("wallet_ledger_entries", "transaction_id", rollback.body.transactionId as string)).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - ROLLBACK sem referência no payload", () => {
  test("POST /wagering/transactions with kind ROLLBACK and no referenceExternalTransactionId returns 400 and persists no WagerTransaction", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId, { kind: "ROLLBACK" }), `provider-a:${randomUUID()}`);

      expect(status).toBe(400);
      expect(JSON.stringify(body.message)).toContain("referenceExternalTransactionId");
      expect(await countWhere("wager_transactions", "wallet_id", walletId)).toBe(0);
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

describe("POST /wagering/transactions - kind fora do domínio", () => {
  test("POST /wagering/transactions with a kind outside the domain's known set returns 400 identifying the unsupported kind and persists no WagerTransaction", async () => {
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

describe("POST /wagering/transactions - outbox: eventos de sucesso que movem saldo", () => {
  test("BET processed enqueues WagerTransactionProcessed and WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(betPayload(walletId), `provider-a:${randomUUID()}`);
      expect(status).toBe(201);

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("WIN without a reference enqueues WagerTransactionProcessed and WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "WIN", money: { amount: "50.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(201);

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("WIN with a resolved BET reference enqueues WagerTransactionProcessed and WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const betExternalId = randomUUID();
      const bet = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: betExternalId, money: { amount: "25.00", currency: "BRL" } }),
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

      const types = await outboxEventTypesForTransaction(win.body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("REFUND processed enqueues WagerTransactionProcessed and WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const betExternalId = randomUUID();
      const bet = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: betExternalId, money: { amount: "25.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(bet.status).toBe(201);

      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(refund.status).toBe(201);

      const types = await outboxEventTypesForTransaction(refund.body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("ROLLBACK processed enqueues WagerTransactionProcessed and WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const betExternalId = randomUUID();
      const bet = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: betExternalId, money: { amount: "25.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(bet.status).toBe(201);

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(rollback.status).toBe(201);

      const types = await outboxEventTypesForTransaction(rollback.body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - outbox: LOSS", () => {
  test("LOSS processed enqueues only WagerTransactionProcessed, never WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "LOSS", money: { amount: "25.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(201);

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionProcessed"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - outbox: rejeição por regra de negócio", () => {
  test("BET rejected for insufficient funds enqueues only WagerTransactionRejected", async () => {
    const walletId = await insertWallet("20.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { money: { amount: "20.01", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(422);
      expect(body.failureCode).toBe("INSUFFICIENT_FUNDS");

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionRejected"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("LOSS rejected for currency mismatch enqueues only WagerTransactionRejected", async () => {
    const walletId = await insertWallet("1000.00", "BRL");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "LOSS", money: { amount: "25.00", currency: "USD" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(422);
      expect(body.failureCode).toBe("CURRENCY_MISMATCH");

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionRejected"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("WIN rejected for reference mismatch enqueues only WagerTransactionRejected", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, {
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: randomUUID(),
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(422);
      expect(body.failureCode).toBe("REFERENCE_MISMATCH");

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionRejected"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("REFUND rejected for reference mismatch enqueues only WagerTransactionRejected", async () => {
    const walletId = await insertWallet("1000.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const winExternalId = randomUUID();
      const win = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: winExternalId, kind: "WIN", money: { amount: "10.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);

      // REFUND só aceita referenciar uma BET - referenciar a WIN acima é tão inválido quanto uma
      // referência divergente (ARCHITECTURE.md seção 9).
      const refund = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "REFUND",
          money: { amount: "10.00", currency: "BRL" },
          referenceExternalTransactionId: winExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(refund.status).toBe(422);
      expect(refund.body.failureCode).toBe("REFERENCE_MISMATCH");

      const types = await outboxEventTypesForTransaction(refund.body.transactionId as string);
      expect(types).toEqual(["WagerTransactionRejected"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("ROLLBACK rejected for reversal would cause negative balance enqueues only WagerTransactionRejected", async () => {
    const walletId = await insertWallet("10.00");
    const providerId = "provider-a";
    const playerId = randomUUID();
    const roundId = `round-${randomUUID()}`;
    try {
      const winExternalId = randomUUID();
      const win = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, externalTransactionId: winExternalId, kind: "WIN", money: { amount: "50.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(win.status).toBe(201);

      const bet = await postBet(
        betPayload(walletId, { providerId, playerId, roundId, money: { amount: "55.00", currency: "BRL" } }),
        `provider-a:${randomUUID()}`,
      );
      expect(bet.status).toBe(201);

      const rollback = await postBet(
        betPayload(walletId, {
          providerId,
          playerId,
          roundId,
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: winExternalId,
        }),
        `provider-a:${randomUUID()}`,
      );
      expect(rollback.status).toBe(422);
      expect(rollback.body.failureCode).toBe("REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE");

      const types = await outboxEventTypesForTransaction(rollback.body.transactionId as string);
      expect(types).toEqual(["WagerTransactionRejected"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - outbox: PENDING_REFERENCE", () => {
  test("REFUND with a missing reference enqueues exactly one WagerTransactionPendingReference matching attempts and nextAttemptAt", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "REFUND", money: { amount: "25.00", currency: "BRL" }, referenceExternalTransactionId: randomUUID() }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(202);

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionPendingReference"]);

      const metadata = await pendingReferenceMetadataFor(body.transactionId as string);
      const [payload] = await outboxPayloadsFor(walletId, "WagerTransactionPendingReference");
      const data = payload?.data as { attempts: number; nextAttemptAt: string };
      expect(data.attempts).toBe(metadata.attempts);
      expect(new Date(data.nextAttemptAt)).toEqual(metadata.nextAttemptAt);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("ROLLBACK with a missing reference enqueues exactly one WagerTransactionPendingReference matching attempts and nextAttemptAt", async () => {
    const walletId = await insertWallet("1000.00");
    try {
      const { status, body } = await postBet(
        betPayload(walletId, { kind: "ROLLBACK", money: { amount: "25.00", currency: "BRL" }, referenceExternalTransactionId: randomUUID() }),
        `provider-a:${randomUUID()}`,
      );
      expect(status).toBe(202);

      const types = await outboxEventTypesForTransaction(body.transactionId as string);
      expect(types).toEqual(["WagerTransactionPendingReference"]);

      const metadata = await pendingReferenceMetadataFor(body.transactionId as string);
      const [payload] = await outboxPayloadsFor(walletId, "WagerTransactionPendingReference");
      const data = payload?.data as { attempts: number; nextAttemptAt: string };
      expect(data.attempts).toBe(metadata.attempts);
      expect(new Date(data.nextAttemptAt)).toEqual(metadata.nextAttemptAt);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});

describe("POST /wagering/transactions - outbox: replay nunca duplica um evento", () => {
  test("repeating the Idempotency-Key while PENDING_REFERENCE does not enqueue a second WagerTransactionPendingReference", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const refundPayload = betPayload(walletId, {
      kind: "REFUND",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: randomUUID(),
    });
    try {
      const first = await postBet(refundPayload, idempotencyKey);
      expect(first.status).toBe(202);

      const replay = await postBet(refundPayload, idempotencyKey);
      expect(replay.status).toBe(202);
      expect(replay.body.idempotentReplay).toBe(true);

      const types = await outboxEventTypesForTransaction(first.body.transactionId as string);
      expect(types).toEqual(["WagerTransactionPendingReference"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("replaying an already PROCESSED BET does not enqueue a second WagerTransactionProcessed or WalletBalanceChanged", async () => {
    const walletId = await insertWallet("1000.00");
    const idempotencyKey = `provider-a:${randomUUID()}`;
    const payload = betPayload(walletId, { money: { amount: "25.00", currency: "BRL" } });
    try {
      const first = await postBet(payload, idempotencyKey);
      expect(first.status).toBe(201);

      const replay = await postBet(payload, idempotencyKey);
      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);

      const types = await outboxEventTypesForTransaction(first.body.transactionId as string);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });
});
