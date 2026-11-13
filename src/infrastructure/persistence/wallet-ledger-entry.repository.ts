import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, type FilterQuery } from "@mikro-orm/postgresql";
import type { LedgerPagination, WalletLedgerEntryRepository } from "../../application/ports/wallet-ledger-entry.repository";
import { decodeLedgerCursor } from "../../application/ports/wallet-ledger-entry.repository";
import { Money } from "../../domain/money";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { LedgerDirection } from "../../domain/wager-transaction";
import { WalletLedgerEntryEntity } from "./wallet-ledger-entry.entity";

export function ledgerEntryToDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.walletId,
    transactionId: entity.transactionId,
    direction: entity.direction as LedgerDirection,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.moneyCurrency }),
    balanceBefore: Money.from({ amount: entity.balanceBeforeAmount, currency: entity.moneyCurrency }),
    balanceAfter: Money.from({ amount: entity.balanceAfterAmount, currency: entity.moneyCurrency }),
    createdAt: entity.createdAt,
  });
}

export function ledgerEntryToEntityData(
  entry: WalletLedgerEntry,
): Required<
  Pick<
    WalletLedgerEntryEntity,
    | "id"
    | "walletId"
    | "transactionId"
    | "direction"
    | "moneyAmount"
    | "moneyCurrency"
    | "balanceBeforeAmount"
    | "balanceAfterAmount"
    | "createdAt"
  >
> {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    moneyAmount: entry.money.toJSON().amount,
    moneyCurrency: entry.money.toJSON().currency,
    balanceBeforeAmount: entry.balanceBefore.toJSON().amount,
    balanceAfterAmount: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

@Injectable()
export class WalletLedgerEntryMikroOrmRepository implements WalletLedgerEntryRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly cursorSecret: string,
  ) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    // Insert-only, nunca upsert: um lançamento de ledger já persistido não pode ser regravado -
    // uma segunda chamada com o mesmo id deve estourar a constraint única, não sobrescrever.
    await this.em.insert(WalletLedgerEntryEntity, ledgerEntryToEntityData(entry));
  }

  async findByWalletId(walletId: string, pagination: LedgerPagination): Promise<WalletLedgerEntry[]> {
    const where: FilterQuery<WalletLedgerEntryEntity> = { walletId };
    if (pagination.cursor) {
      const { createdAt, id } = decodeLedgerCursor(pagination.cursor, this.cursorSecret);
      where.$or = [{ createdAt: { $gt: createdAt } }, { createdAt, id: { $gt: id } }];
    }
    const entities = await this.em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: "ASC", id: "ASC" },
      limit: pagination.limit,
    });
    return entities.map(ledgerEntryToDomain);
  }
}
