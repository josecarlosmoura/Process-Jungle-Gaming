import { randomUUID } from "node:crypto";
import type { FailureCode } from "../../domain/failure-code";
import { CurrencyMismatchError, type Money } from "../../domain/money";
import type { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction";
import { InsufficientFundsError, type Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { ReferenceResolution } from "../reference-resolver";

export interface ReversalAcceptanceRules {
  acceptableReferenceKinds: ReadonlySet<WagerTransactionKind>;
  // Ausente para REFUND - credit() nunca lança InsufficientFundsError, então não há
  // failureCode de "saldo insuficiente" a mapear nesse caminho.
  insufficientFundsFailureCode?: FailureCode;
}

export type ReversalEffectResult =
  | { outcome: "PROCESSED"; ledgerEntry: WalletLedgerEntry }
  | { outcome: "REJECTED"; failureCode: FailureCode };

// ROLLBACK aceita qualquer kind que tenha afetado o saldo - nunca LOSS (não há efeito a desfazer).
const ROLLBACK_REFERENCEABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set(["BET", "WIN", "REFUND"]);

export const REFUND_ACCEPTANCE_RULES: ReversalAcceptanceRules = {
  acceptableReferenceKinds: new Set(["BET"]),
};

export const ROLLBACK_ACCEPTANCE_RULES: ReversalAcceptanceRules = {
  acceptableReferenceKinds: ROLLBACK_REFERENCEABLE_KINDS,
  insufficientFundsFailureCode: "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",
};

// Decide o efeito de uma referência já resolvida (ou terminalmente inválida) para uma REFUND/
// ROLLBACK - extraído de ProcessWagerTransactionUseCase para que a submissão original e o worker
// de reprocessamento (T212) nunca possam divergir nos mesmos failureCodes. Só chamado quando
// resolution.outcome !== "NOT_FOUND" - NOT_FOUND tem tratamento próprio e divergente em cada
// chamador (esperar markPendingReference na primeira submissão, scheduleReferenceRetry/reject por
// esgotamento no worker).
export function applyResolvedReversal(
  transaction: WagerTransaction,
  wallet: Wallet,
  resolution: ReferenceResolution,
  money: Money,
  rules: ReversalAcceptanceRules,
  now: Date,
): ReversalEffectResult {
  function reject(failureCode: FailureCode): ReversalEffectResult {
    transaction.reject(failureCode);
    return { outcome: "REJECTED", failureCode };
  }

  if (resolution.outcome === "UNRESOLVABLE") {
    return reject("REFERENCE_NOT_FOUND");
  }
  if (resolution.outcome === "ALREADY_REVERSED") {
    return reject("REFERENCE_ALREADY_REVERSED");
  }
  if (resolution.outcome !== "RESOLVED" || !rules.acceptableReferenceKinds.has(resolution.reference.kind)) {
    return reject("REFERENCE_MISMATCH");
  }

  const reference = resolution.reference;
  // Reversão parcial está fora de escopo - o valor precisa ser exatamente o da referência
  // original (não só a mesma moeda, já garantida pelo ReferenceResolver).
  if (!money.equals(reference.money)) {
    return reject("REFERENCE_AMOUNT_MISMATCH");
  }

  const direction = transaction.ledgerDirectionFor(reference);
  const balanceBefore = wallet.balance;
  try {
    if (direction === "DEBIT") {
      wallet.debit(money);
    } else {
      wallet.credit(money);
    }
  } catch (error) {
    if (error instanceof CurrencyMismatchError) {
      return reject("CURRENCY_MISMATCH");
    }
    if (error instanceof InsufficientFundsError && rules.insufficientFundsFailureCode) {
      return reject(rules.insufficientFundsFailureCode);
    }
    throw error;
  }

  transaction.markProcessed(reference.id, now);
  const ledgerEntry = WalletLedgerEntry.create({
    id: randomUUID(),
    walletId: wallet.id,
    transactionId: transaction.id,
    direction,
    money,
    balanceBefore,
    balanceAfter: wallet.balance,
  });
  return { outcome: "PROCESSED", ledgerEntry };
}
