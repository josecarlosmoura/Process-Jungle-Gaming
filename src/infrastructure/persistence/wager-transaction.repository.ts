import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction.repository";
import type { FailureCode } from "../../domain/failure-code";
import { Money } from "../../domain/money";
import {
  WagerTransaction,
  type ReversalKind,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { WagerTransactionEntity } from "./wager-transaction.entity";

export function wagerTransactionToDomain(entity: WagerTransactionEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    // Colunas nullable devolvem "null" do driver, nunca "undefined"; o domínio usa "undefined"
    // para "ausente", então toda coluna nullable converte explicitamente nesta borda.
    providerId: entity.providerId ?? undefined,
    externalTransactionId: entity.externalTransactionId ?? undefined,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash ?? undefined,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId ?? undefined,
    gameId: entity.gameId ?? undefined,
    kind: entity.kind as WagerTransactionKind,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.moneyCurrency }),
    referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
    createdAt: entity.createdAt,
    status: entity.status as WagerTransactionStatus,
    referenceTransactionId: entity.referenceTransactionId ?? undefined,
    // RN-53/ARCHITECTURE.md secao 9: a coluna guarda qualquer string gravada por reject()/fail(),
    // que ja restringe o valor a FailureCode em tempo de compilacao - so o driver, que devolve
    // "string" bruto, precisa do cast nesta borda (mesmo padrao de kind/status acima).
    failureCode: (entity.failureCode as FailureCode | null) ?? undefined,
    processedAt: entity.processedAt ?? undefined,
    balanceAfterProcessing:
      entity.balanceAfterAmount != null && entity.balanceAfterCurrency != null
        ? Money.from({ amount: entity.balanceAfterAmount, currency: entity.balanceAfterCurrency })
        : undefined,
    attempts: entity.attempts ?? undefined,
    nextAttemptAt: entity.nextAttemptAt ?? undefined,
  });
}

export function wagerTransactionToEntityData(transaction: WagerTransaction): Required<
  Pick<
    WagerTransactionEntity,
    "id" | "idempotencyKey" | "walletId" | "playerId" | "kind" | "moneyAmount" | "moneyCurrency" | "status" | "createdAt"
  >
> &
  Pick<
    WagerTransactionEntity,
    | "providerId"
    | "externalTransactionId"
    | "payloadHash"
    | "roundId"
    | "gameId"
    | "referenceExternalTransactionId"
    | "referenceTransactionId"
    | "failureCode"
    | "processedAt"
    | "balanceAfterAmount"
    | "balanceAfterCurrency"
    | "attempts"
    | "nextAttemptAt"
  > {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    moneyAmount: transaction.money.toJSON().amount,
    moneyCurrency: transaction.money.toJSON().currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt,
    balanceAfterAmount: transaction.balanceAfterProcessing?.toJSON().amount,
    balanceAfterCurrency: transaction.balanceAfterProcessing?.toJSON().currency,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt,
  };
}

@Injectable()
export class WagerTransactionMikroOrmRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey: key });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId: externalId,
    });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async findReversalOf(referenceTransactionId: string, reversalKind: ReversalKind): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      referenceTransactionId,
      kind: reversalKind,
    });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.upsert(WagerTransactionEntity, wagerTransactionToEntityData(transaction));
    await this.em.flush();
  }

  async claimPendingReferenceBatch(now: Date, limit: number): Promise<WagerTransaction[]> {
    // LockMode.PESSIMISTIC_PARTIAL_WRITE -> "FOR UPDATE SKIP LOCKED", mesmo mecanismo de
    // OutboxMessageMikroOrmRepository.claimPendingBatch - precisa rodar dentro de uma transação já
    // aberta pelo chamador; o lock dura até ela comitar/abortar. nextAttemptAt nunca é null aqui
    // (markPendingReference/scheduleReferenceRetry sempre o preenchem junto com attempts), então,
    // diferente da outbox, não há um ramo "nunca tentado" a considerar.
    const entities = await this.em.find(
      WagerTransactionEntity,
      { status: "PENDING_REFERENCE", nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return entities.map(wagerTransactionToDomain);
  }
}
