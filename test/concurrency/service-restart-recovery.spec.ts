import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { Test } from "@nestjs/testing";

// Mesmo padrao de test/concurrency/concurrent-bet.spec.ts - env setado antes do import dinamico de
// qualquer modulo, nunca depois de um import estatico no topo do arquivo.
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
  PORT: "4326",
  // 1s: curto o bastante para a segunda instancia (o "reinicio") alcancar a linha pendente dentro
  // do timeout deste teste, mas ainda bem mais longo do que o tempo que a primeira instancia leva
  // entre nascer e ser fechada (algumas chamadas HTTP) - o primeiro ciclo real do scheduler dela
  // (t=0, antes da wallet existir) nao acha nada, e o segundo ciclo (t=1000ms) nunca chega a
  // acontecer porque a fechamos antes disso.
  OUTBOX_PUBLISHER_POLL_INTERVAL_MS: "1000",
});

const { AppModule } = await import("../../src/app.module");
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

const PORT = 4326;
const baseUrl = `http://127.0.0.1:${PORT}`;

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

afterAll(async () => {
  await orm.close();
});

async function deleteWalletCascade(walletId: string): Promise<void> {
  await connection.execute("delete from outbox_messages where aggregate_id = ?", [walletId]);
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
}

// Boota uma instancia inteira da aplicacao (AppModule completo, com seu proprio
// OutboxPublisherScheduler real) - cada chamada compila um DI container novo e independente a
// partir do MESMO AppModule ja importado (mesmo padrao de duas instancias reais em
// wager-transaction-sqs.consumer.integration.spec.ts), nunca a mesma instancia reaproveitada.
async function bootInstance(): Promise<{ close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.init();
  await app.listen(PORT);
  return {
    close: () => app.close(),
  };
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

async function postBet(walletId: string, amount: string): Promise<{ status: number; body: TransactionResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `provider-restart:${randomUUID()}` },
    body: JSON.stringify({
      providerId: "provider-restart",
      externalTransactionId: randomUUID(),
      playerId: randomUUID(),
      walletId,
      roundId: "round-restart",
      gameId: "restart-scenario",
      kind: "BET",
      money: { amount, currency: "BRL" },
    }),
  });
  return { status: response.status, body: (await response.json()) as TransactionResponseBody };
}

async function countPendingOutbox(walletId: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    "select count(*) as count from outbox_messages where aggregate_id = ? and published_at is null",
    [walletId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function waitForAllPublished(walletId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countPendingOutbox(walletId)) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`outbox messages for wallet ${walletId} never all published within ${timeoutMs}ms`);
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

describe("consistencia final apos um reinicio do servico", () => {
  test(
    "a new instance publishes the pending outbox message after restart, automatically and without a manual call, once a previous instance committed a BET's financial effect but closed before its own OutboxPublisherScheduler cycle reached it",
    async () => {
      const first = await bootInstance();
      const wallet = await createWallet("100.00");
      try {
        const bet = await postBet(wallet.id, "20.00");
        expect(bet.status).toBe(201);
        expect(bet.body.status).toBe("PROCESSED");

        // Confirmacao direta: o efeito financeiro e a linha pendente do outbox existem no banco
        // antes de "matarmos" esta primeira instancia.
        const walletAfterCommit = await readWallet(wallet.id);
        expect(walletAfterCommit.balance_amount).toBe("80.00");
        expect(await countPendingOutbox(wallet.id)).toBeGreaterThanOrEqual(1);

        await first.close();

        // "Reinicio": uma instancia nova, com seu proprio OutboxPublisherScheduler real - nenhuma
        // chamada manual ao caso de uso a partir daqui.
        const second = await bootInstance();
        try {
          // waitForAllPublished so confirma depois que outbox_messages.published_at de fato foi
          // preenchido - e PublishOutboxUseCase.execute() so faz isso DEPOIS que
          // IntegrationEventPublisher.publish() (um SendMessageCommand real) resolve sem lancar
          // (publish-outbox.use-case.ts) - published_at != null ja e, por construcao, prova de
          // publicacao real na fila, sem precisar vascular a fila compartilhada de novo aqui.
          await waitForAllPublished(wallet.id);

          const finalWallet = await readWallet(wallet.id);
          expect(finalWallet.balance_amount).toBe("80.00");
          const reconstructed = await reconstructLedgerBalance(wallet.id, finalWallet.currency);
          expect(reconstructed.toJSON()).toEqual({ amount: finalWallet.balance_amount, currency: finalWallet.currency });
        } finally {
          await second.close();
        }
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    45_000,
  );
});
