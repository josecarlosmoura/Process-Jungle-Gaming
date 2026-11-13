import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../application/ports/wallet.repository";
import { Money } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import { WalletEntity } from "./wallet.entity";

export function walletToDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    balance: Money.from({ amount: entity.balanceAmount, currency: entity.currency }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

export function walletToEntityData(wallet: Wallet): Required<Pick<WalletEntity, "id" | "playerId" | "currency" | "balanceAmount" | "version" | "createdAt" | "updatedAt">> {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceAmount: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

@Injectable()
export class WalletMikroOrmRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? walletToDomain(entity) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? walletToDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity ? walletToDomain(entity) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    await this.em.upsert(WalletEntity, walletToEntityData(wallet));
    await this.em.flush();
  }
}
