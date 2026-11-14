import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";

// Este arquivo nunca sobe sua propria instancia da aplicacao (nenhum app.listen() aqui) - ele fala
// HTTP de verdade com as 3 replicas reais do docker-compose.test.yml (T214), descobertas pela
// porta de host que o Docker atribuiu a cada uma. Pre-requisito (ver plan.md/checks.md S1):
//   docker compose -f docker-compose.test.yml up -d --scale app=3
// As 3 replicas e este teste compartilham o MESMO Postgres/LocalStack do docker-compose.yml (porta
// de host 5440/4566, igual aos demais arquivos de test/concurrency/).
const { validateEnv } = await import("../../src/infrastructure/config/env.schema");
const { buildMikroOrmOptions } = await import("../../src/infrastructure/database/mikro-orm.config");
const { Money } = await import("../../src/domain/money");

const env = validateEnv({
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
});
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

const REPLICA_COUNT = 3;

// "docker compose port --index <n> app 3000" le a porta de host de verdade atribuida pelo Docker a
// cada replica escalada - nunca nomeia containers (incompativel com "--scale") e nunca assume uma
// porta fixa (cada "up --scale" pode atribuir portas diferentes). Mesmo mecanismo de
// Bun.spawnSync ja usado no repo para scripts/setup-queues.sh
// (publish-outbox.use-case.integration.spec.ts).
function discoverInstancePorts(replicaCount: number): number[] {
  const ports: number[] = [];
  for (let index = 1; index <= replicaCount; index++) {
    const result = Bun.spawnSync(
      ["docker", "compose", "-f", "docker-compose.test.yml", "port", "--index", String(index), "app", "3000"],
      { cwd: process.cwd() },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `nao foi possivel descobrir a porta da replica ${index} de "app" - suba a infraestrutura antes ` +
          `deste teste: docker compose -f docker-compose.test.yml up -d --scale app=${replicaCount}. ` +
          `stderr: ${result.stderr.toString().trim()}`,
      );
    }
    const output = result.stdout.toString().trim();
    const match = output.match(/:(\d+)\s*$/);
    if (!match?.[1]) {
      throw new Error(`saida inesperada de "docker compose port --index ${index} app 3000": "${output}"`);
    }
    ports.push(Number(match[1]));
  }
  return ports;
}

const instancePorts = discoverInstancePorts(REPLICA_COUNT);
const baseUrls = instancePorts.map((port) => `http://127.0.0.1:${port}`);

afterAll(async () => {
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

async function createWallet(baseUrl: string, initialAmount: string, currency = "BRL"): Promise<WalletResponseBody> {
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

async function postBet(
  baseUrl: string,
  body: unknown,
  idempotencyKey: string,
): Promise<{ status: number; body: BetResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
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

describe("3 ou mais instancias fisicas distintas da aplicacao (docker-compose.test.yml --scale app=3)", () => {
  test(
    "discovers 3 distinct healthy app instances",
    async () => {
      expect(new Set(instancePorts).size).toBe(REPLICA_COUNT);
      for (const baseUrl of baseUrls) {
        const response = await fetch(`${baseUrl}/health/ready`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok", postgres: "up", sqs: "up" });
      }
    },
    15_000,
  );

  test(
    "two parallel BETs across two distinct app instances against a wallet with 100.00 BRL leave exactly one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, final balance 20.00 BRL, matching the ledger",
    async () => {
      const wallet = await createWallet(baseUrls[0] as string, "100.00");
      try {
        const bet = () => ({
          providerId: "provider-multi-instance",
          externalTransactionId: randomUUID(),
          playerId: randomUUID(),
          walletId: wallet.id,
          roundId: "round-multi-instance",
          gameId: "multi-instance-scenario",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        });

        // Uma BET vai para a replica 1, a outra para a replica 2 - processos Bun/Node distintos,
        // nunca o mesmo processo em portas diferentes. So o Postgres (lock pessimista por
        // walletId) decide o vencedor, nenhum estado compartilhado em memoria entre as replicas.
        const [first, second] = await Promise.all([
          postBet(baseUrls[0] as string, bet(), `provider-multi-instance:${randomUUID()}`),
          postBet(baseUrls[1] as string, bet(), `provider-multi-instance:${randomUUID()}`),
        ]);
        const results = [first, second];

        const processed = results.filter((result) => result.body.status === "PROCESSED");
        const rejected = results.filter((result) => result.body.status === "REJECTED");

        expect(processed.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(processed[0]?.status).toBe(201);
        expect(rejected[0]?.status).toBe(422);
        expect(rejected[0]?.body.failureCode).toBe("INSUFFICIENT_FUNDS");

        const finalWallet = await readWallet(wallet.id);
        expect(finalWallet.balance_amount).toBe("20.00");
        await expectBalanceMatchesLedger(wallet.id);
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    20_000,
  );

  test(
    "50 identical parallel POSTs (same Idempotency-Key) distributed round-robin across the 3 app instances debit the wallet exactly once, matching the ledger",
    async () => {
      const wallet = await createWallet(baseUrls[0] as string, "1000.00");
      const idempotencyKey = `provider-multi-instance:${randomUUID()}`;
      const payload = {
        providerId: "provider-multi-instance",
        externalTransactionId: "dup-multi-instance-001",
        playerId: randomUUID(),
        walletId: wallet.id,
        roundId: "round-multi-instance-dup",
        gameId: "multi-instance-dup-scenario",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      };
      try {
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, i) => postBet(baseUrls[i % REPLICA_COUNT] as string, payload, idempotencyKey)),
        );

        const created = responses.filter((response) => response.status === 201);
        const replayed = responses.filter((response) => response.status === 200);

        // Mesma garantia de test/concurrency/idempotency-key-race.spec.ts, agora provada entre
        // processos distintos: nenhuma replica decide a partir de cache/estado em memoria proprio -
        // so a constraint unica do Postgres em wager_transactions.idempotency_key arbitra a corrida.
        expect(created.length).toBe(1);
        expect(replayed.length).toBe(49);

        const transactionId = created[0]?.body.transactionId;
        expect(transactionId).toBeDefined();
        for (const response of responses) {
          expect(response.body.transactionId).toBe(transactionId);
        }

        const finalWallet = await readWallet(wallet.id);
        expect(finalWallet.balance_amount).toBe("990.00");
        await expectBalanceMatchesLedger(wallet.id);
      } finally {
        await deleteWalletCascade(wallet.id);
      }
    },
    30_000,
  );
});
