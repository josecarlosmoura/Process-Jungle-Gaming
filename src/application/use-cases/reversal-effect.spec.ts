import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Money } from "../../domain/money";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import type { ReferenceResolution } from "../reference-resolver";
import {
  REFUND_ACCEPTANCE_RULES,
  ROLLBACK_ACCEPTANCE_RULES,
  applyResolvedReversal,
  type ReversalAcceptanceRules,
} from "./reversal-effect";

function aWallet(balanceAmount: string, currency = "BRL"): Wallet {
  return Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: Money.from({ amount: balanceAmount, currency }),
  });
}

function aReversal(kind: "REFUND" | "ROLLBACK", amount = "20.00"): WagerTransaction {
  const transaction = WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: "wallet-a",
    playerId: "player-a",
    roundId: "round-a",
    gameId: "game-a",
    kind,
    money: Money.from({ amount, currency: "BRL" }),
    referenceExternalTransactionId: randomUUID(),
  });
  transaction.markPendingReference(new Date());
  return transaction;
}

function aReference(
  overrides: { kind?: WagerTransactionKind; amount?: string; currency?: string; status?: WagerTransactionStatus } = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    walletId: "wallet-a",
    playerId: "player-a",
    roundId: "round-a",
    gameId: "game-a",
    kind: overrides.kind ?? "BET",
    money: Money.from({ amount: overrides.amount ?? "20.00", currency: overrides.currency ?? "BRL" }),
    createdAt: new Date(),
    status: overrides.status ?? "PROCESSED",
  });
}

const resolved = (reference: WagerTransaction): ReferenceResolution => ({ outcome: "RESOLVED", reference });
const unresolvable: ReferenceResolution = { outcome: "UNRESOLVABLE" };
const alreadyReversed: ReferenceResolution = { outcome: "ALREADY_REVERSED" };

describe("applyResolvedReversal", () => {
  test("resolution UNRESOLVABLE rejects with REFERENCE_NOT_FOUND", () => {
    const transaction = aReversal("REFUND");
    const wallet = aWallet("100.00");

    const effect = applyResolvedReversal(transaction, wallet, unresolvable, transaction.money, REFUND_ACCEPTANCE_RULES, new Date());

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "REFERENCE_NOT_FOUND" });
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
  });

  test("resolution ALREADY_REVERSED rejects with REFERENCE_ALREADY_REVERSED", () => {
    const transaction = aReversal("ROLLBACK");
    const wallet = aWallet("100.00");

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      alreadyReversed,
      transaction.money,
      ROLLBACK_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
  });

  test("resolution RESOLVED with a kind outside acceptableReferenceKinds rejects with REFERENCE_MISMATCH", () => {
    const transaction = aReversal("REFUND");
    const wallet = aWallet("100.00");
    const reference = aReference({ kind: "WIN" }); // REFUND só aceita BET.

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      REFUND_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "REFERENCE_MISMATCH" });
  });

  test("resolution RESOLVED with a different amount rejects with REFERENCE_AMOUNT_MISMATCH", () => {
    const transaction = aReversal("REFUND", "20.00");
    const wallet = aWallet("100.00");
    const reference = aReference({ kind: "BET", amount: "30.00" });

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      REFUND_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "REFERENCE_AMOUNT_MISMATCH" });
  });

  test("resolution RESOLVED with a different currency rejects with CURRENCY_MISMATCH", () => {
    const transaction = aReversal("REFUND", "20.00");
    const wallet = aWallet("100.00", "USD");
    const reference = aReference({ kind: "BET", amount: "20.00", currency: "BRL" });

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      REFUND_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
  });

  test("a ROLLBACK debit that would leave the wallet negative rejects with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE", () => {
    const transaction = aReversal("ROLLBACK", "50.00");
    const wallet = aWallet("10.00"); // saldo insuficiente para o débito reverso de uma WIN.
    const reference = aReference({ kind: "WIN", amount: "50.00" });

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      ROLLBACK_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect).toEqual({ outcome: "REJECTED", failureCode: "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE" });
    expect(wallet.balance.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("insufficient funds without a mapped failureCode propagates instead of being swallowed", () => {
    // REFUND nunca passa por aqui na pratica (credit() nao lanca InsufficientFundsError), mas a
    // regra em si - "sem failureCode mapeado, o erro sobe" - precisa ficar provada diretamente.
    const rulesWithoutMapping: ReversalAcceptanceRules = { acceptableReferenceKinds: new Set(["WIN"]) };
    const transaction = aReversal("ROLLBACK", "50.00");
    const wallet = aWallet("10.00");
    const reference = aReference({ kind: "WIN", amount: "50.00" });

    expect(() =>
      applyResolvedReversal(transaction, wallet, resolved(reference), transaction.money, rulesWithoutMapping, new Date()),
    ).toThrow();
  });

  test("a REFUND resolution applies a CREDIT and marks the transaction PROCESSED", () => {
    const transaction = aReversal("REFUND", "20.00");
    const wallet = aWallet("100.00");
    const reference = aReference({ kind: "BET", amount: "20.00" });
    const now = new Date("2026-01-01T00:00:00.000Z");

    const effect = applyResolvedReversal(transaction, wallet, resolved(reference), transaction.money, REFUND_ACCEPTANCE_RULES, now);

    expect(effect.outcome).toBe("PROCESSED");
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.referenceTransactionId).toBe(reference.id);
    expect(wallet.balance.toJSON()).toEqual({ amount: "120.00", currency: "BRL" });
    if (effect.outcome === "PROCESSED") {
      expect(effect.ledgerEntry.direction).toBe("CREDIT");
    }
  });

  test("a ROLLBACK of a BET applies a CREDIT and marks the transaction PROCESSED", () => {
    const transaction = aReversal("ROLLBACK", "20.00");
    const wallet = aWallet("100.00");
    const reference = aReference({ kind: "BET", amount: "20.00" });

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      ROLLBACK_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect.outcome).toBe("PROCESSED");
    expect(wallet.balance.toJSON()).toEqual({ amount: "120.00", currency: "BRL" });
    if (effect.outcome === "PROCESSED") {
      expect(effect.ledgerEntry.direction).toBe("CREDIT");
    }
  });

  test("a ROLLBACK of a WIN applies a DEBIT and marks the transaction PROCESSED", () => {
    const transaction = aReversal("ROLLBACK", "20.00");
    const wallet = aWallet("100.00");
    const reference = aReference({ kind: "WIN", amount: "20.00" });

    const effect = applyResolvedReversal(
      transaction,
      wallet,
      resolved(reference),
      transaction.money,
      ROLLBACK_ACCEPTANCE_RULES,
      new Date(),
    );

    expect(effect.outcome).toBe("PROCESSED");
    expect(wallet.balance.toJSON()).toEqual({ amount: "80.00", currency: "BRL" });
    if (effect.outcome === "PROCESSED") {
      expect(effect.ledgerEntry.direction).toBe("DEBIT");
    }
  });
});
