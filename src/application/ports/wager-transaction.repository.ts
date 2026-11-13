import type { WagerTransaction } from "../../domain/wager-transaction";

export const WAGER_TRANSACTION_REPOSITORY_INTERFACE = Symbol("WagerTransactionRepository");

export interface WagerTransactionRepository {
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
}
