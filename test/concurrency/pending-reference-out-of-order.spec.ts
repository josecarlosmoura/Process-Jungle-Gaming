import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// @nestjs/config le process.env no instante em que o modulo e importado - por isso o env precisa
// ser setado antes do import dinamico de AppModule, nunca depois de um import estatico no topo do
// arquivo (mesmo padrao de test/concurrency/concurrent-bet.spec.ts).
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
  PORT: "4325",
  // Reduzido so para este teste poder esperar a resolucao automatica dentro de um timeout curto -
  // o default de producao (5000ms) tornaria o teste lento sem nenhum ganho de cobertura.
  PENDING_REFERENCE_REPROCESSOR_POLL_INTERVAL_MS: "300",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

const PORT = 4325;
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
  // PendingReferenceReprocessorScheduler.onApplicationBootstrap ja agenda seu primeiro ciclo aqui -
  // nenhum teste abaixo chama o caso de uso manualmente, a resolucao e sempre do worker real.
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
  failureCode?: string;
}

async function createWallet(initialAmount: string, currency = "BRL"): Promise<WalletResponseBody> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: initialAmount, currency } }),
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

async function readWagerTransactionStatus(walletId: string, externalTransactionId: string): Promise<string | undefined> {
  const rows = await connection.execute<{ status: string }[]>(
    "select status from wager_transactions where wallet_id = ? and external_transaction_id = ?",
    [walletId, externalTransactionId],
  );
  return rows[0]?.status;
}

async function waitForStatus(
  walletId: string,
  externalTransactionId: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readWagerTransactionStatus(walletId, externalTransactionId)) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `wager_transaction (wallet ${walletId}, external id ${externalTransactionId}) never reached status ${expected} within ${timeoutMs}ms`,
  );
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

describe("REFUND entregue antes do BET referenciado existir", () => {
  test(
    "a REFUND whose referenced BET does not exist yet responds 202 PENDING_REFERENCE",
    async () => {
      const wallet = await createWallet("100.00");
      const providerId = "provider-pending-reference";
      const playerId = randomUUID();
      const roundId = `round-${randomUUID()}`;
      const neverSeenBetExternalId = `bet-${randomUUID()}`;
      try {
        const refund = await postWagerTransaction(
          {
            providerId,
            externalTransactionId: `refund-${randomUUID()}`,
            playerId,
            walletId: wallet.id,
            roundId,
            gameId: "pending-reference-scenario",
            kind: "REFUND",
            money: { amount: "20.00", currency: "BRL" },
            referenceExternalTransactionId: neverSeenBetExternalId,
          },
          `${providerId}:${randomUUID()}`,
        );

        expect(refund.status).toBe(202);
        expect(refund.body.status).toBe("PENDING_REFERENCE");
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    10_000,
  );

  test(
    "once the referenced BET arrives and is PROCESSED, the PendingReferenceReprocessorScheduler already running on the same instance resolves the REFUND to PROCESSED automatically, crediting the wallet back, matching the ledger",
    async () => {
      const wallet = await createWallet("100.00");
      const providerId = "provider-pending-reference";
      const playerId = randomUUID();
      const roundId = `round-${randomUUID()}`;
      const betExternalId = `bet-${randomUUID()}`;
      const refundExternalId = `refund-${randomUUID()}`;

      try {
        // REFUND chega primeiro - a referencia ainda nao existe.
        const refund = await postWagerTransaction(
          {
            providerId,
            externalTransactionId: refundExternalId,
            playerId,
            walletId: wallet.id,
            roundId,
            gameId: "pending-reference-scenario",
            kind: "REFUND",
            money: { amount: "20.00", currency: "BRL" },
            referenceExternalTransactionId: betExternalId,
          },
          `${providerId}:${refundExternalId}`,
        );
        expect(refund.body.status).toBe("PENDING_REFERENCE");

        // Agora a BET referenciada chega e e PROCESSED.
        const bet = await postWagerTransaction(
          {
            providerId,
            externalTransactionId: betExternalId,
            playerId,
            walletId: wallet.id,
            roundId,
            gameId: "pending-reference-scenario",
            kind: "BET",
            money: { amount: "20.00", currency: "BRL" },
          },
          `${providerId}:${betExternalId}`,
        );
        expect(bet.status).toBe(201);
        expect(bet.body.status).toBe("PROCESSED");

        // Nenhuma chamada manual ao worker daqui - so espera o
        // PendingReferenceReprocessorScheduler, ja em execucao na mesma instancia desde
        // beforeAll, resolver sozinho dentro do seu proprio ciclo. markPendingReference() fixa o
        // primeiro nextAttemptAt em now + WagerTransaction.INITIAL_PENDING_REFERENCE_DELAY_MS
        // (60s, constante de dominio) - reduzir o poll interval do scheduler nunca antecipa isso;
        // o teste precisa mesmo esperar essa janela real (mesmo valor documentado no README:
        // "aguarde o nextAttemptAt (1min por padrao)... sleep 65").
        await waitForStatus(wallet.id, refundExternalId, "PROCESSED", 70_000);

        const finalWallet = await readWallet(wallet.id);
        expect(finalWallet.balance_amount).toBe("100.00");

        const reconstructed = await reconstructLedgerBalance(wallet.id, finalWallet.currency);
        expect(reconstructed.toJSON()).toEqual({ amount: finalWallet.balance_amount, currency: finalWallet.currency });
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    80_000,
  );
});
