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
    "two concurrent ROLLBACK POSTs reversing two different PROCESSED WINs on the same wallet, where the balance only covers one of the two reverse debits, leave exactly one 201 PROCESSED DEBIT and the other 422 REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE, balance never negative",
    async () => {
      const wallet = await createWallet("0.00");
      const providerId = "provider-rollback-race-balance";
      const playerId = randomUUID();
      const roundId = "round-rollback-race-balance";
      const winAExternalId = `win-a-${randomUUID()}`;
      const winBExternalId = `win-b-${randomUUID()}`;

      // Duas referencias distintas (nao a mesma WIN) - condicao necessaria para que a corrida
      // force de fato o ramo de saldo negativo em vez de ser decidida antes disso pelo guard de
      // "ja revertida" (esse e o papel de C13, nao deste teste): com referencias diferentes,
      // REFERENCE_ALREADY_REVERSED nunca entra em jogo para o perdedor.
      const winA = await postWagerTransaction(
        {
          providerId,
          externalTransactionId: winAExternalId,
          playerId,
          walletId: wallet.id,
          roundId,
          gameId: "rollback-race-balance-scenario",
          kind: "WIN",
          money: { amount: "20.00", currency: "BRL" },
        },
        `${providerId}:${winAExternalId}`,
      );
      expect(winA.status).toBe(201);

      const winB = await postWagerTransaction(
        {
          providerId,
          externalTransactionId: winBExternalId,
          playerId,
          walletId: wallet.id,
          roundId,
          gameId: "rollback-race-balance-scenario",
          kind: "WIN",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:${winBExternalId}`,
      );
      expect(winB.status).toBe(201);
      expect(winB.body.balance).toEqual({ amount: "45.00", currency: "BRL" });

      // BET intermediaria deixa o saldo em 30.00 - cabe um debito reverso de 20.00 (sobra 10.00)
      // ou de 25.00 (sobra 5.00), mas nunca os dois (20 + 25 = 45 > 30).
      const bet = await postWagerTransaction(
        {
          providerId,
          externalTransactionId: `bet-${randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId,
          gameId: "rollback-race-balance-scenario",
          kind: "BET",
          money: { amount: "15.00", currency: "BRL" },
        },
        `${providerId}:bet-${randomUUID()}`,
      );
      expect(bet.status).toBe(201);
      expect(bet.body.balance).toEqual({ amount: "30.00", currency: "BRL" });

      try {
        // first e second correspondem, por posicao, a ROLLBACK-A (20.00) e ROLLBACK-B (25.00) -
        // essa correspondencia nao muda com a ordem de chegada no servidor; so qual delas ganha o
        // lock da wallet e nao-deterministico.
        const [first, second] = await Promise.all([
          postWagerTransaction(
            {
              providerId,
              playerId,
              walletId: wallet.id,
              roundId,
              gameId: "rollback-race-balance-scenario",
              kind: "ROLLBACK",
              money: { amount: "20.00", currency: "BRL" },
              referenceExternalTransactionId: winAExternalId,
              externalTransactionId: `rollback-a-${randomUUID()}`,
            },
            `${providerId}:rollback-a-${randomUUID()}`,
          ),
          postWagerTransaction(
            {
              providerId,
              playerId,
              walletId: wallet.id,
              roundId,
              gameId: "rollback-race-balance-scenario",
              kind: "ROLLBACK",
              money: { amount: "25.00", currency: "BRL" },
              referenceExternalTransactionId: winBExternalId,
              externalTransactionId: `rollback-b-${randomUUID()}`,
            },
            `${providerId}:rollback-b-${randomUUID()}`,
          ),
        ]);

        const aSucceeded = first.status === 201;
        const expectedBalance = aSucceeded ? "10.00" : "5.00";

        expect(first.status === 201 ? second.status : first.status).toBe(422);
        expect(first.body.status).toBe(aSucceeded ? "PROCESSED" : "REJECTED");
        expect(second.body.status).toBe(aSucceeded ? "REJECTED" : "PROCESSED");
        // Referencias distintas - o perdedor nunca encontra REFERENCE_ALREADY_REVERSED (nenhum
        // ROLLBACK anterior aponta para a referencia dele), so o guard de saldo.
        expect(aSucceeded ? second.body.failureCode : first.body.failureCode).toBe(
          "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
        );

        const rows = await connection.execute<{ balance_amount: string }[]>(
          "select balance_amount from wallets where id = ?",
          [wallet.id],
        );
        // Exatamente uma das duas reversoes aplicada - nunca as duas, e nunca negativo.
        expect(rows[0]?.balance_amount).toBe(expectedBalance);
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    10_000,
  );
});
