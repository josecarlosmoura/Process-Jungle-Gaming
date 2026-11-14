import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { RequestContext } from "@mikro-orm/core";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../../infrastructure/config/env.schema";
import { buildMikroOrmOptions } from "../../infrastructure/database/mikro-orm.config";
import { OutboxMessageMikroOrmRepository } from "../../infrastructure/persistence/outbox-message.repository";
import { WagerTransactionMikroOrmRepository } from "../../infrastructure/persistence/wager-transaction.repository";
import { WalletLedgerEntryMikroOrmRepository } from "../../infrastructure/persistence/wallet-ledger-entry.repository";
import { WalletMikroOrmRepository } from "../../infrastructure/persistence/wallet.repository";
import { Money } from "../../domain/money";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { ReferenceResolver } from "../reference-resolver";
import { ReprocessPendingReferenceUseCase } from "./reprocess-pending-reference.use-case";

// Forca wagering_test independente de como o teste e invocado - mesmo padrao dos demais
// *.integration.spec.ts.
Object.assign(process.env, { DB_NAME: "wagering_test" });

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

function useCaseOn(em: EntityManager, batchSize = 20): ReprocessPendingReferenceUseCase {
  const wagerTransactionRepository = new WagerTransactionMikroOrmRepository(em);
  return new ReprocessPendingReferenceUseCase(
    em,
    new WalletMikroOrmRepository(em),
    wagerTransactionRepository,
    new WalletLedgerEntryMikroOrmRepository(em, "dev-only-ledger-cursor-secret-not-for-production"),
    new OutboxMessageMikroOrmRepository(em),
    new ReferenceResolver(wagerTransactionRepository),
    batchSize,
  );
}

// em.transactional() so propaga a transacao via AsyncLocalStorage para outros consumidores do
// MESMO em quando chamado sobre o em "global" (orm.em) - mesmo raciocinio de
// publish-outbox.use-case.integration.spec.ts.
function makeUseCase(batchSize = 20): ReprocessPendingReferenceUseCase {
  return useCaseOn(orm.em, batchSize);
}

function moneyOf(amount: string, currency = "BRL") {
  return Money.from({ amount, currency });
}

// orm.em.fork() em toda chamada de repositorio feita fora de um use case (que já abre sua própria
// transação) - o em "global" não aceita save()/flush() direto (MikroORM 6: "cannotUseGlobalContext"),
// mesmo padrão de wallet.repository.integration.spec.ts.
async function insertWallet(balanceAmount: string, currency = "BRL"): Promise<string> {
  const id = randomUUID();
  await new WalletMikroOrmRepository(orm.em.fork()).save(
    Wallet.open({ id, playerId: randomUUID(), initialBalance: moneyOf(balanceAmount, currency) }),
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

interface Subject {
  walletId: string;
  playerId: string;
  roundId: string;
  providerId: string;
}

function aSubject(walletId: string): Subject {
  return { walletId, playerId: randomUUID(), roundId: `round-${randomUUID()}`, providerId: "provider-a" };
}

async function saveProcessedReference(
  subject: Subject,
  kind: "BET" | "WIN",
  externalTransactionId: string,
  amount: string,
): Promise<WagerTransaction> {
  const transaction = WagerTransaction.create({
    id: randomUUID(),
    providerId: subject.providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: subject.walletId,
    playerId: subject.playerId,
    roundId: subject.roundId,
    gameId: "game-a",
    kind,
    money: moneyOf(amount),
  });
  transaction.markProcessed(undefined, new Date());
  await new WagerTransactionMikroOrmRepository(orm.em.fork()).save(transaction);
  return transaction;
}

async function saveRejectedReference(subject: Subject, kind: "BET" | "WIN", externalTransactionId: string, amount: string): Promise<WagerTransaction> {
  const transaction = WagerTransaction.create({
    id: randomUUID(),
    providerId: subject.providerId,
    externalTransactionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: subject.walletId,
    playerId: subject.playerId,
    roundId: subject.roundId,
    gameId: "game-a",
    kind,
    money: moneyOf(amount),
  });
  transaction.reject("INSUFFICIENT_FUNDS");
  await new WagerTransactionMikroOrmRepository(orm.em.fork()).save(transaction);
  return transaction;
}

async function savePendingReferenceReversal(
  subject: Subject,
  kind: "REFUND" | "ROLLBACK",
  referenceExternalTransactionId: string,
  amount: string,
  opts: { attempts: number; createdAt?: Date; nextAttemptAt?: Date },
): Promise<WagerTransaction> {
  const createdAt = opts.createdAt ?? new Date();
  const transaction = WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: subject.providerId,
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: subject.walletId,
    playerId: subject.playerId,
    roundId: subject.roundId,
    gameId: "game-a",
    kind,
    money: moneyOf(amount),
    referenceExternalTransactionId,
    createdAt,
    status: "PENDING_REFERENCE",
    attempts: opts.attempts,
    nextAttemptAt: opts.nextAttemptAt ?? new Date(Date.now() - 1_000),
  });
  await new WagerTransactionMikroOrmRepository(orm.em.fork()).save(transaction);
  return transaction;
}

async function reread(idempotencyKey: string): Promise<WagerTransaction | null> {
  return new WagerTransactionMikroOrmRepository(orm.em.fork()).findByIdempotencyKey(idempotencyKey);
}

async function countLedgerEntries(transactionId: string): Promise<number> {
  const rows = await connection.execute<{ count: string }[]>(
    "select count(*) as count from wallet_ledger_entries where transaction_id = ?",
    [transactionId],
  );
  return Number(rows[0]?.count ?? 0);
}

// Achado do Verifier independente (verification.md): countLedgerEntries() por si só nao prova a
// direcao que o proprio nome do check promete - um bug que trocasse o ledgerEntry persistido por
// outro (ex.: debit no lugar de credit) passaria pelo count=1 sem ser pego.
async function ledgerDirectionFor(transactionId: string): Promise<string | null> {
  const rows = await connection.execute<{ direction: string }[]>(
    "select direction from wallet_ledger_entries where transaction_id = ?",
    [transactionId],
  );
  return rows[0]?.direction ?? null;
}

async function outboxEventTypesForTransaction(transactionId: string): Promise<string[]> {
  const rows = await connection.execute<{ event_type: string }[]>(
    `select event_type from outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by event_type asc`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
}

describe("ReprocessPendingReferenceUseCase.execute - integração (Postgres real)", () => {
  test("a PENDING_REFERENCE REFUND whose BET arrives afterward is resolved to PROCESSED with a CREDIT ledger entry", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const subject = aSubject(walletId);
      const betExternalId = randomUUID();
      const refund = await savePendingReferenceReversal(subject, "REFUND", betExternalId, "20.00", { attempts: 1 });
      const bet = await saveProcessedReference(subject, "BET", betExternalId, "20.00");

      await makeUseCase().execute();

      const resolved = await reread(refund.idempotencyKey);
      expect(resolved?.status).toBe("PROCESSED");
      expect(resolved?.referenceTransactionId).toBe(bet.id);
      expect(await countLedgerEntries(refund.id)).toBe(1);
      expect(await ledgerDirectionFor(refund.id)).toBe("CREDIT");
      expect(await outboxEventTypesForTransaction(refund.id)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("a PENDING_REFERENCE ROLLBACK whose WIN arrives afterward is resolved to PROCESSED with a DEBIT ledger entry", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const subject = aSubject(walletId);
      const winExternalId = randomUUID();
      const rollback = await savePendingReferenceReversal(subject, "ROLLBACK", winExternalId, "20.00", { attempts: 1 });
      await saveProcessedReference(subject, "WIN", winExternalId, "20.00");

      await makeUseCase().execute();

      const resolved = await reread(rollback.idempotencyKey);
      expect(resolved?.status).toBe("PROCESSED");
      expect(await countLedgerEntries(rollback.id)).toBe(1);
      expect(await ledgerDirectionFor(rollback.id)).toBe("DEBIT");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("running execute again after a resolution does not create a second ledger entry or a second outbox event", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const subject = aSubject(walletId);
      const betExternalId = randomUUID();
      const refund = await savePendingReferenceReversal(subject, "REFUND", betExternalId, "20.00", { attempts: 1 });
      await saveProcessedReference(subject, "BET", betExternalId, "20.00");

      await makeUseCase().execute();
      await makeUseCase().execute();

      expect(await countLedgerEntries(refund.id)).toBe(1);
      expect(await outboxEventTypesForTransaction(refund.id)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("attempts 9 schedules a 10th retry, attempts 10 rejects with REFERENCE_NOT_FOUND", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const almostExhausted = await savePendingReferenceReversal(aSubject(walletId), "REFUND", randomUUID(), "20.00", {
        attempts: 9,
      });
      const exhausted = await savePendingReferenceReversal(aSubject(walletId), "REFUND", randomUUID(), "20.00", {
        attempts: WagerTransaction.MAX_PENDING_REFERENCE_ATTEMPTS,
      });

      await makeUseCase().execute();

      const stillPending = await reread(almostExhausted.idempotencyKey);
      expect(stillPending?.status).toBe("PENDING_REFERENCE");
      expect(stillPending?.attempts).toBe(10);

      const rejected = await reread(exhausted.idempotencyKey);
      expect(rejected?.status).toBe("REJECTED");
      expect(rejected?.failureCode).toBe("REFERENCE_NOT_FOUND");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("a reference past the 24h TTL rejects with REFERENCE_NOT_FOUND even with attempts still low", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const pastTtl = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const transaction = await savePendingReferenceReversal(aSubject(walletId), "ROLLBACK", randomUUID(), "20.00", {
        attempts: 2,
        createdAt: pastTtl,
      });

      await makeUseCase().execute();

      const rejected = await reread(transaction.idempotencyKey);
      expect(rejected?.status).toBe("REJECTED");
      expect(rejected?.failureCode).toBe("REFERENCE_NOT_FOUND");
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test("a reference that already ended REJECTED rejects immediately with REFERENCE_NOT_FOUND on a retry cycle", async () => {
    const walletId = await insertWallet("100.00");
    try {
      const subject = aSubject(walletId);
      const betExternalId = randomUUID();
      const refund = await savePendingReferenceReversal(subject, "REFUND", betExternalId, "20.00", { attempts: 1 });
      await saveRejectedReference(subject, "BET", betExternalId, "20.00");

      await makeUseCase().execute();

      const rejected = await reread(refund.idempotencyKey);
      expect(rejected?.status).toBe("REJECTED");
      expect(rejected?.failureCode).toBe("REFERENCE_NOT_FOUND");
      // Esgotamento nao e o motivo da rejeicao aqui - attempts ainda estava bem abaixo do limite.
      expect(rejected?.attempts).toBe(1);
    } finally {
      await deleteWalletCascade(walletId);
    }
  });

  test(
    "two concurrent execute calls over the same resolvable row apply the effect exactly once",
    async () => {
      const walletId = await insertWallet("100.00");
      try {
        const subject = aSubject(walletId);
        const betExternalId = randomUUID();
        const refund = await savePendingReferenceReversal(subject, "REFUND", betExternalId, "20.00", { attempts: 1 });
        await saveProcessedReference(subject, "BET", betExternalId, "20.00");

        // RequestContext.create forka orm.em por chamada (mesmo mecanismo do
        // PendingReferenceReprocessorScheduler em produção, um ciclo por instância) - os
        // repositórios de makeUseCase() continuam ligados ao orm.em "global", mas cada
        // RequestContext.create resolve esse mesmo em para o SEU PRÓPRIO fork via
        // AsyncLocalStorage, o que dá a cada chamada concorrente sua própria conexão/transação
        // real para provar FOR UPDATE SKIP LOCKED sob concorrência de verdade (não apenas
        // sequencial). Um orm.em.fork() passado direto ao construtor do use case não teria esse
        // mesmo efeito, pois só o em "global" ganha essa resolução automática de contexto.
        await Promise.all([
          RequestContext.create(orm.em, () => makeUseCase().execute()),
          RequestContext.create(orm.em, () => makeUseCase().execute()),
        ]);

        const resolved = await reread(refund.idempotencyKey);
        expect(resolved?.status).toBe("PROCESSED");
        expect(await countLedgerEntries(refund.id)).toBe(1);
      } finally {
        await deleteWalletCascade(walletId);
      }
    },
    10_000,
  );
});
