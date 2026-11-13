import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction.repository";
import { Money } from "../../domain/money";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "../../domain/wager-transaction";
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
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
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

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.upsert(WagerTransactionEntity, wagerTransactionToEntityData(transaction));
    await this.em.flush();
  }
}
