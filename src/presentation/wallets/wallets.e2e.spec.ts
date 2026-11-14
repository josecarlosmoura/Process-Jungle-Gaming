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
  DB_NAME: "wagering_test",
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
const { Money } = await import("../../domain/money");
const { WagerTransaction } = await import("../../domain/wager-transaction");
const { WalletLedgerEntry } = await import("../../domain/wallet-ledger-entry");
const { WagerTransactionMikroOrmRepository } = await import("../../infrastructure/persistence/wager-transaction.repository");
const { WalletLedgerEntryMikroOrmRepository } = await import("../../infrastructure/persistence/wallet-ledger-entry.repository");

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
  failureCode?: string;
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
  await connection.execute("delete from outbox_messages where aggregate_id = ?", [walletId]);
  await connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [walletId]);
  await connection.execute("delete from wager_transactions where wallet_id = ?", [walletId]);
  await connection.execute("delete from wallets where id = ?", [walletId]);
}

async function outboxEventTypesFor(walletId: string): Promise<string[]> {
  const rows = await connection.execute<{ event_type: string }[]>(
    "select event_type from outbox_messages where aggregate_id = ? order by occurred_at asc, event_type asc",
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

interface LedgerEntryResponseBody {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyBody;
  balanceBefore: MoneyBody;
  balanceAfter: MoneyBody;
  createdAt: string;
}

interface LedgerResponseBody {
  entries?: LedgerEntryResponseBody[];
  nextCursor?: string;
  message?: unknown;
}

async function getLedger(
  walletId: string,
  query: { cursor?: string; limit?: string } = {},
): Promise<{ status: number; body: LedgerResponseBody }> {
  const params = new URLSearchParams();
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", query.limit);
  const qs = params.toString();
  const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger${qs ? `?${qs}` : ""}`);
  return { status: response.status, body: (await response.json()) as LedgerResponseBody };
}

// Semeia uma BET + seu lancamento de ledger diretamente via repositorio (sem passar pelo
// POST /wagering/transactions) - mais rapido, e esta suite testa a paginacao da leitura, nao o
// caminho de escrita (ja coberto em wagering.e2e.spec.ts). sleep de 5ms entre cada uma garante
// createdAt estritamente crescente, como aconteceria sob o lock pessimista por walletId (nunca
// duas escritas concorrentes na mesma wallet).
async function seedLedgerEntry(walletId: string, balanceBefore: string, debit: string): Promise<string> {
  const transactionId = randomUUID();
  const transaction = WagerTransaction.create({
    id: transactionId,
    providerId: "provider-ledger-test",
    externalTransactionId: randomUUID(),
    idempotencyKey: `provider-ledger-test:${randomUUID()}`,
    payloadHash: "a".repeat(64),
    walletId,
    playerId: randomUUID(),
    roundId: randomUUID(),
    gameId: "slot-ledger-test",
    kind: "BET",
    money: Money.from({ amount: debit, currency: "BRL" }),
  });
  await new WagerTransactionMikroOrmRepository(orm.em.fork()).save(transaction);

  const entry = WalletLedgerEntry.create({
    id: randomUUID(),
    walletId,
    transactionId,
    direction: "DEBIT",
    money: Money.from({ amount: debit, currency: "BRL" }),
    balanceBefore: Money.from({ amount: balanceBefore, currency: "BRL" }),
    balanceAfter: Money.from({ amount: balanceBefore, currency: "BRL" }).subtract(Money.from({ amount: debit, currency: "BRL" })),
  });
  await new WalletLedgerEntryMikroOrmRepository(orm.em.fork(), "dev-only-ledger-cursor-secret-not-for-production").save(entry);

  await new Promise((resolve) => setTimeout(resolve, 5));
  return entry.id;
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    `select count(*) as count from ${table} where ${column} = ?`,
    [value],
  );
  return Number(rows[0]?.count ?? 0);
}

// Saldo inicial zero -> sem OPENING nem lancamento de ledger automatico (ja garantido pelos
// testes de "POST /wallets - sem saldo inicial" abaixo), entao os unicos lancamentos da wallet sao
// os que seedLedgerEntry cria explicitamente - sem isso, o lancamento CREDIT da OPENING apareceria
// antes dos lancamentos semeados e quebraria a ordem esperada nos testes de paginacao.
async function createEmptyWallet(): Promise<string> {
  const created = await postWallet({ playerId: randomUUID(), initialBalance: { amount: "0.00", currency: "BRL" } });
  return created.body.id;
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
      expect(second.body.failureCode).toBeUndefined();

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

describe("POST /wallets - outbox", () => {
  test("POST /wallets with a positive initialBalance enqueues WagerTransactionProcessed and WalletBalanceChanged for the OPENING transaction", async () => {
    const playerId = randomUUID();
    const { status, body } = await postWallet({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });

    try {
      expect(status).toBe(201);
      const types = await outboxEventTypesFor(body.id);
      expect(types.sort()).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(body.id);
    }
  });

  test("POST /wallets with a zero initialBalance enqueues nothing", async () => {
    const playerId = randomUUID();
    const { status, body } = await postWallet({ playerId, initialBalance: { amount: "0.00", currency: "BRL" } });

    try {
      expect(status).toBe(201);
      expect(await outboxEventTypesFor(body.id)).toEqual([]);
    } finally {
      await deleteWalletCascade(body.id);
    }
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  test("returns 200 with up to limit entries ordered by createdAt ascending, including nextCursor on a non-empty page", async () => {
    const walletId = await createEmptyWallet();
    try {
      const e1 = await seedLedgerEntry(walletId, "1000.00", "10.00");
      const e2 = await seedLedgerEntry(walletId, "990.00", "10.00");
      await seedLedgerEntry(walletId, "980.00", "10.00");

      const { status, body } = await getLedger(walletId, { limit: "2" });

      expect(status).toBe(200);
      expect(body.entries?.map((e) => e.id)).toEqual([e1, e2]);
      expect(typeof body.nextCursor).toBe("string");
      expect(body.nextCursor?.length).toBeGreaterThan(0);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("using nextCursor from a page returns exactly the remaining entries, without repeating or skipping", async () => {
    const walletId = await createEmptyWallet();
    try {
      await seedLedgerEntry(walletId, "1000.00", "10.00");
      await seedLedgerEntry(walletId, "990.00", "10.00");
      const e3 = await seedLedgerEntry(walletId, "980.00", "10.00");

      const page1 = await getLedger(walletId, { limit: "2" });
      const cursor = page1.body.nextCursor as string;

      const page2 = await getLedger(walletId, { cursor, limit: "2" });

      expect(page2.status).toBe(200);
      expect(page2.body.entries?.map((e) => e.id)).toEqual([e3]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("an exhausted cursor returns entries empty and omits nextCursor", async () => {
    const walletId = await createEmptyWallet();
    try {
      await seedLedgerEntry(walletId, "1000.00", "10.00");
      const lastId = await seedLedgerEntry(walletId, "990.00", "10.00");

      const page1 = await getLedger(walletId, { limit: "2" });
      expect(page1.body.entries?.map((e) => e.id)).toEqual(expect.arrayContaining([lastId]));
      const cursor = page1.body.nextCursor as string;

      const page2 = await getLedger(walletId, { cursor, limit: "2" });

      expect(page2.status).toBe(200);
      expect(page2.body.entries).toEqual([]);
      expect(page2.body.nextCursor).toBeUndefined();
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("a new entry inserted between fetching page 1 and page 2 (with page 1's cursor) does not corrupt pagination", async () => {
    const walletId = await createEmptyWallet();
    try {
      await seedLedgerEntry(walletId, "1000.00", "10.00");
      await seedLedgerEntry(walletId, "990.00", "10.00");
      const e3 = await seedLedgerEntry(walletId, "980.00", "10.00");

      const page1 = await getLedger(walletId, { limit: "2" });
      const cursorAfterPage1 = page1.body.nextCursor as string;

      // Insercao concorrente entre as duas chamadas de paginacao - o cenario exigido pela tarefa.
      const e4 = await seedLedgerEntry(walletId, "970.00", "10.00");

      const page2 = await getLedger(walletId, { cursor: cursorAfterPage1, limit: "10" });

      expect(page2.status).toBe(200);
      expect(page2.body.entries?.map((e) => e.id)).toEqual([e3, e4]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("returns 400 for a limit that is not a positive integer", async () => {
    const walletId = await createEmptyWallet();
    try {
      const { status } = await getLedger(walletId, { limit: "0" });
      expect(status).toBe(400);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("returns 400 for a malformed or tampered cursor", async () => {
    const walletId = await createEmptyWallet();
    try {
      const { status } = await getLedger(walletId, { cursor: "not-a-valid-cursor" });
      expect(status).toBe(400);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("returns 404 for a well-formed but unknown walletId", async () => {
    const { status } = await getLedger(randomUUID());
    expect(status).toBe(404);
  });

  test("returns 400 for a malformed non-UUID walletId", async () => {
    const { status } = await getLedger("not-a-uuid");
    expect(status).toBe(400);
  });
});
