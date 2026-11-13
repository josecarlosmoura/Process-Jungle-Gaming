import type { ReversalKind, WagerTransaction } from "../../domain/wager-transaction";

export const WAGER_TRANSACTION_REPOSITORY_INTERFACE = Symbol("WagerTransactionRepository");

export interface WagerTransactionRepository {
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null>;
  // So encontra uma reversao que ja chegou a PROCESSED - reference_transaction_id so e
  // preenchido por markProcessed(), nunca por reject()/fail(), entao uma tentativa rejeitada de
  // REFUND/ROLLBACK nunca conta como "ja revertida".
  findReversalOf(
    referenceTransactionId: string,
    reversalKind: ReversalKind,
  ): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
}
