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
  PORT: "4324",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

const PORT = 4324;
const baseUrl = `http://127.0.0.1:${PORT}`;
const WALLET_COUNT = 20;

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

async function postBet(walletId: string, amount: string, currency = "BRL"): Promise<{ status: number; body: BetResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `provider-distinct-wallets:${randomUUID()}`,
    },
    body: JSON.stringify({
      providerId: "provider-distinct-wallets",
      externalTransactionId: randomUUID(),
      playerId: randomUUID(),
      walletId,
      roundId: "round-distinct-wallets",
      gameId: "distinct-wallets-scenario",
      kind: "BET",
      money: { amount, currency },
    }),
  });
  return { status: response.status, body: (await response.json()) as BetResponseBody };
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

async function readWallet(walletId: string): Promise<{ balance_amount: string; currency: string }> {
  const rows = await connection.execute<{ balance_amount: string; currency: string }[]>(
    "select balance_amount, currency from wallets where id = ?",
    [walletId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  return row;
}

async function expectBalanceMatchesLedger(walletId: string): Promise<void> {
  const wallet = await readWallet(walletId);
  const reconstructed = await reconstructLedgerBalance(walletId, wallet.currency);
  expect(reconstructed.toJSON()).toEqual({ amount: wallet.balance_amount, currency: wallet.currency });
}

describe("wallets distintas processadas em paralelo - ausencia de lock global", () => {
  test(
    `${WALLET_COUNT} concurrent BETs across ${WALLET_COUNT} distinct wallets all process correctly and finish well under half the time the same load takes sequentially, each wallet matching its ledger`,
    async () => {
      // Linha de base sequencial: mede o custo real de WALLET_COUNT BETs rodadas uma apos a outra
      // (nunca um numero fixo em ms, por ser dependente da maquina/CI). Comparar contra essa
      // medicao, nao contra uma constante, e exatamente o ponto de atencao da propria tarefa sobre
      // falso negativo em CI mais lento.
      const sequentialWallets = await Promise.all(
        Array.from({ length: WALLET_COUNT }, () => createWallet("100.00")),
      );
      const sequentialStart = performance.now();
      for (const wallet of sequentialWallets) {
        const result = await postBet(wallet.id, "10.00");
        expect(result.status).toBe(201);
      }
      const sequentialMs = performance.now() - sequentialStart;

      // Carga real do teste: as mesmas WALLET_COUNT BETs, agora em paralelo (Promise.all), sobre um
      // lote novo de wallets.
      const parallelWallets = await Promise.all(
        Array.from({ length: WALLET_COUNT }, () => createWallet("100.00")),
      );
      try {
        const parallelStart = performance.now();
        const results = await Promise.all(parallelWallets.map((wallet) => postBet(wallet.id, "10.00")));
        const parallelMs = performance.now() - parallelStart;

        for (const result of results) {
          expect(result.status).toBe(201);
          expect(result.body.status).toBe("PROCESSED");
        }

        for (const wallet of parallelWallets) {
          const finalWallet = await readWallet(wallet.id);
          expect(finalWallet.balance_amount).toBe("90.00");
          await expectBalanceMatchesLedger(wallet.id);
        }

        // Com lock por wallet (nunca global), WALLET_COUNT operacoes independentes em paralelo
        // custam uma fracao pequena do tempo sequencial, nunca perto de 100% dele (que e o que um
        // lock global acidental produziria, serializando-as de volta por debaixo do pano). Metade
        // do tempo sequencial e uma margem generosa o bastante para nao reagir a ruido de I/O
        // normal, mas ainda detectar essa falha especifica.
        expect(parallelMs).toBeLessThan(sequentialMs / 2);
      } finally {
        await Promise.all([...sequentialWallets, ...parallelWallets].map((wallet) => deleteWalletCascade(wallet.id)));
      }
    },
    30_000,
  );
});
