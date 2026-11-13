import type { Wallet } from "../../domain/wallet";

export const WALLET_REPOSITORY_INTERFACE = Symbol("WalletRepository");

export interface WalletRepository {
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}
