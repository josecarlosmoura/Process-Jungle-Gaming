import { Inject, Injectable } from "@nestjs/common";
import type { Money } from "../domain/money";
import type { ReversalKind, WagerTransaction } from "../domain/wager-transaction";
import type { WagerTransactionRepository } from "./ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "./ports/wager-transaction.repository";

export interface ReferenceSubject {
  providerId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  money: Money;
}

export interface ResolveReferenceParams extends ReferenceSubject {
  referenceExternalTransactionId: string;
  // Ausente quando a referência é apenas opcional (como a de um resultado vencedor) - só quem
  // está de fato revertendo uma transação precisa da checagem de "já revertida pelo mesmo tipo".
  reversalKind?: ReversalKind;
}

export type ReferenceResolution =
  | { outcome: "RESOLVED"; reference: WagerTransaction }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNRESOLVABLE" }
  | { outcome: "MISMATCH" }
  | { outcome: "ALREADY_REVERSED" };

// PENDING/PENDING_REFERENCE ainda podem chegar a PROCESSED - tratados como ausentes (nunca como
// rejeicao definitiva), para que quem chama possa decidir esperar essa referencia resolver.
const STILL_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(["PENDING", "PENDING_REFERENCE"]);

@Injectable()
export class ReferenceResolver {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE)
    private readonly wagerTransactionRepository: WagerTransactionRepository,
  ) {}

  async resolve(params: ResolveReferenceParams): Promise<ReferenceResolution> {
    const reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
      params.providerId,
      params.referenceExternalTransactionId,
    );

    if (!reference || STILL_IN_FLIGHT_STATUSES.has(reference.status)) {
      return { outcome: "NOT_FOUND" };
    }
    // Terminal mas nunca PROCESSED (REJECTED/FAILED): estruturalmente nunca vai se tornar valida -
    // distinto de NOT_FOUND para que quem chama rejeite de imediato em vez de esperar via
    // PENDING_REFERENCE um resultado que nunca vai chegar.
    if (reference.status !== "PROCESSED") {
      return { outcome: "UNRESOLVABLE" };
    }
    if (!this.matchesSubject(reference, params)) {
      return { outcome: "MISMATCH" };
    }
    if (params.reversalKind) {
      const existingReversal = await this.wagerTransactionRepository.findReversalOf(
        reference.id,
        params.reversalKind,
      );
      if (existingReversal) {
        return { outcome: "ALREADY_REVERSED" };
      }
    }
    return { outcome: "RESOLVED", reference };
  }

  // Os cinco campos que precisam bater entre a referencia e quem a referencia - moeda comparada
  // via Money.hasSameCurrency, nunca uma string crua separada do payload.
  private matchesSubject(reference: WagerTransaction, subject: ReferenceSubject): boolean {
    return (
      reference.providerId === subject.providerId &&
      reference.playerId === subject.playerId &&
      reference.walletId === subject.walletId &&
      reference.roundId === subject.roundId &&
      reference.money.hasSameCurrency(subject.money)
    );
  }
}
