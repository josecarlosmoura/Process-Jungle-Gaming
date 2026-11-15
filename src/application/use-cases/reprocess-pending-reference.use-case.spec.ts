import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ConsoleLogger, Logger } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import type { OutboxMessage } from "../../domain/outbox-message";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { LogContextService } from "../../infrastructure/observability/log-context.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { OutboxMessageRepository } from "../ports/outbox-message.repository";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import type { ReferenceResolver } from "../reference-resolver";
import { ReprocessPendingReferenceUseCase } from "./reprocess-pending-reference.use-case";

function fakeEntityManager(): EntityManager {
  return {
    transactional: async (cb: () => Promise<void>) => cb(),
    execute: async () => undefined,
  } as unknown as EntityManager;
}

function fakeReferenceResolver(outcome: "NOT_FOUND" = "NOT_FOUND"): ReferenceResolver {
  return { resolve: async () => ({ outcome }) } as unknown as ReferenceResolver;
}

function fakeOutboxMessageRepository(): OutboxMessageRepository & { saved: OutboxMessage[] } {
  const saved: OutboxMessage[] = [];
  return {
    saved,
    save: async (message: OutboxMessage) => {
      saved.push(message);
    },
    claimPendingBatch: async () => [],
    updateDeliveryState: async () => undefined,
  };
}

function fakeWalletLedgerEntryRepository(): WalletLedgerEntryRepository {
  return {
    save: async () => undefined,
    findByWalletId: async () => [],
    findByTransactionId: async () => null,
  };
}

function fakeWagerTransactionRepository(): WagerTransactionRepository & { saved: WagerTransaction[] } {
  const saved: WagerTransaction[] = [];
  return {
    saved,
    findByIdempotencyKey: async () => null,
    findByProviderAndExternalId: async () => null,
    findReversalOf: async () => null,
    save: async (transaction: WagerTransaction) => {
      saved.push(transaction);
    },
    claimPendingReferenceBatch: async () => [],
  };
}

function trackingWalletRepository(order: string[]): WalletRepository {
  return {
    findById: async () => null,
    findByIdForUpdate: async (id: string) => {
      order.push(id);
      return Wallet.open({ id, playerId: randomUUID(), initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
    },
    findByPlayerAndCurrency: async () => null,
    save: async () => undefined,
  };
}

function aPendingReferenceTransaction(walletId: string, overrides: { attempts?: number; createdAt?: Date } = {}): WagerTransaction {
  const transaction = WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId,
    playerId: "player-a",
    roundId: "round-a",
    gameId: "game-a",
    kind: "REFUND",
    money: Money.from({ amount: "20.00", currency: "BRL" }),
    referenceExternalTransactionId: randomUUID(),
  });
  transaction.markPendingReference(overrides.createdAt ?? new Date());
  for (let i = 0; i < (overrides.attempts ?? 0); i++) {
    transaction.scheduleReferenceRetry(new Date());
  }
  return transaction;
}

describe("ReprocessPendingReferenceUseCase", () => {
  test("a claimed batch spanning multiple wallets acquires wallet locks sorted by walletId", async () => {
    const callOrder: string[] = [];
    const scrambled = [
      aPendingReferenceTransaction("wallet-c"),
      aPendingReferenceTransaction("wallet-a"),
      aPendingReferenceTransaction("wallet-b"),
    ];
    const wagerTransactionRepository = fakeWagerTransactionRepository();
    wagerTransactionRepository.claimPendingReferenceBatch = async () => scrambled;

    const useCase = new ReprocessPendingReferenceUseCase(
      fakeEntityManager(),
      trackingWalletRepository(callOrder),
      wagerTransactionRepository,
      fakeWalletLedgerEntryRepository(),
      fakeOutboxMessageRepository(),
      fakeReferenceResolver("NOT_FOUND"),
      20,
    );

    await useCase.execute();

    expect(callOrder).toEqual(["wallet-a", "wallet-b", "wallet-c"]);
  });

  test("NOT_FOUND below the attempts/TTL limit schedules a retry and never rejects", async () => {
    MetricsService.resetForTesting();
    const transaction = aPendingReferenceTransaction("wallet-a", { attempts: 3 });
    const wagerTransactionRepository = fakeWagerTransactionRepository();
    wagerTransactionRepository.claimPendingReferenceBatch = async () => [transaction];
    const outbox = fakeOutboxMessageRepository();

    const useCase = new ReprocessPendingReferenceUseCase(
      fakeEntityManager(),
      trackingWalletRepository([]),
      wagerTransactionRepository,
      fakeWalletLedgerEntryRepository(),
      outbox,
      fakeReferenceResolver("NOT_FOUND"),
      20,
    );

    await useCase.execute();

    expect(transaction.status).toBe("PENDING_REFERENCE");
    expect(transaction.attempts).toBe(4);
    expect(outbox.saved).toHaveLength(0);
    expect(await MetricsService.getMetricsText()).toContain("retries_total 1");
  });

  test("NOT_FOUND at the attempts/TTL limit rejects and never schedules another retry", async () => {
    const transaction = aPendingReferenceTransaction("wallet-a", { attempts: WagerTransaction.MAX_PENDING_REFERENCE_ATTEMPTS });
    const wagerTransactionRepository = fakeWagerTransactionRepository();
    wagerTransactionRepository.claimPendingReferenceBatch = async () => [transaction];
    const outbox = fakeOutboxMessageRepository();

    const useCase = new ReprocessPendingReferenceUseCase(
      fakeEntityManager(),
      trackingWalletRepository([]),
      wagerTransactionRepository,
      fakeWalletLedgerEntryRepository(),
      outbox,
      fakeReferenceResolver("NOT_FOUND"),
      20,
    );

    await useCase.execute();

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(transaction.attempts).toBe(WagerTransaction.MAX_PENDING_REFERENCE_ATTEMPTS);
    expect(outbox.saved).toHaveLength(1);
  });

  test("the correlationId logged for a rejected attempt is the exact same one published in its WagerTransactionRejected event", async () => {
    const transaction = aPendingReferenceTransaction("wallet-a", { attempts: WagerTransaction.MAX_PENDING_REFERENCE_ATTEMPTS });
    const wagerTransactionRepository = fakeWagerTransactionRepository();
    wagerTransactionRepository.claimPendingReferenceBatch = async () => [transaction];
    const outbox = fakeOutboxMessageRepository();

    const loggedCorrelationIds: Array<string | undefined> = [];
    Logger.overrideLogger({
      log: () => {},
      error: () => {},
      warn: () => {
        loggedCorrelationIds.push(LogContextService.get().correlationId);
      },
      debug: () => {},
      verbose: () => {},
    });
    try {
      const useCase = new ReprocessPendingReferenceUseCase(
        fakeEntityManager(),
        trackingWalletRepository([]),
        wagerTransactionRepository,
        fakeWalletLedgerEntryRepository(),
        outbox,
        fakeReferenceResolver("NOT_FOUND"),
        20,
      );

      await useCase.execute();
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }

    expect(loggedCorrelationIds).toHaveLength(1);
    const published = outbox.saved[0]?.payload as { correlationId?: string } | undefined;
    expect(published?.correlationId).toBeDefined();
    expect(loggedCorrelationIds[0]).toBe(published?.correlationId);
  });
});
