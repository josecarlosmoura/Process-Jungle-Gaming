import { describe, expect, test } from "bun:test";
import { Money } from "./money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionPayloadError,
  LedgerDirectionNotApplicableError,
  WagerTransaction,
  type CreateOpeningWagerTransactionProps,
  type CreateWagerTransactionProps,
  type WagerTransactionKind,
  type WagerTransactionState,
  type WagerTransactionStatus,
} from "./wager-transaction";

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function buildProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: nextId("tx"),
    providerId: "provider-1",
    externalTransactionId: nextId("ext"),
    idempotencyKey: nextId("idem"),
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    ...overrides,
  };
}

function buildOpeningProps(overrides: Partial<CreateOpeningWagerTransactionProps> = {}): CreateOpeningWagerTransactionProps {
  return {
    id: nextId("tx"),
    idempotencyKey: nextId("idem"),
    walletId: "wallet-1",
    playerId: "player-1",
    money: Money.from({ amount: "100.00", currency: "BRL" }),
    ...overrides,
  };
}

function buildTerminalTransaction(status: WagerTransactionStatus): WagerTransaction {
  const transaction = WagerTransaction.create(buildProps({ kind: "BET" }));
  if (status === "PROCESSED") {
    transaction.markProcessed(undefined, new Date());
  } else if (status === "REJECTED") {
    transaction.reject("INSUFFICIENT_FUNDS");
  } else {
    transaction.fail("INTERNAL_ERROR");
  }
  return transaction;
}

function snapshotOf(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId,
    failureCode: transaction.failureCode,
    processedAt: transaction.processedAt,
  };
}

describe("WagerTransaction", () => {
  test("create with kind BET, WIN or LOSS returns an instance born in PENDING status", () => {
    const kinds: WagerTransactionKind[] = ["BET", "WIN", "LOSS"];
    for (const kind of kinds) {
      const transaction = WagerTransaction.create(buildProps({ kind }));
      expect(transaction.status).toBe("PENDING");
      expect(transaction.kind).toBe(kind);
    }
  });

  test("create with kind REFUND or ROLLBACK and a reference returns an instance born in PENDING with the reference recorded", () => {
    const kinds: WagerTransactionKind[] = ["REFUND", "ROLLBACK"];
    for (const kind of kinds) {
      const transaction = WagerTransaction.create(buildProps({ kind, referenceExternalTransactionId: "ext-ref-1" }));
      expect(transaction.status).toBe("PENDING");
      expect(transaction.referenceExternalTransactionId).toBe("ext-ref-1");
    }
  });

  test("create with kind REFUND or ROLLBACK and no reference throws InvalidWagerTransactionPayloadError, while BET, WIN and LOSS accept a missing reference", () => {
    for (const kind of ["REFUND", "ROLLBACK"] as WagerTransactionKind[]) {
      for (const referenceExternalTransactionId of [undefined, ""]) {
        expect(() => WagerTransaction.create(buildProps({ kind, referenceExternalTransactionId }))).toThrow(
          InvalidWagerTransactionPayloadError,
        );
      }
    }
    for (const kind of ["BET", "WIN", "LOSS"] as WagerTransactionKind[]) {
      expect(() =>
        WagerTransaction.create(buildProps({ kind, referenceExternalTransactionId: undefined })),
      ).not.toThrow();
    }
  });

  test("create with kind OPENING throws InvalidWagerTransactionPayloadError", () => {
    expect(() => WagerTransaction.create(buildProps({ kind: "OPENING" }))).toThrow(
      InvalidWagerTransactionPayloadError,
    );
  });

  test("createOpening returns an instance with kind OPENING born in PENDING status", () => {
    const transaction = WagerTransaction.createOpening(buildOpeningProps());
    expect(transaction.kind).toBe("OPENING");
    expect(transaction.status).toBe("PENDING");
  });

  test("createOpening returns providerId, externalTransactionId, roundId, gameId and payloadHash all undefined, with a non-empty idempotencyKey", () => {
    const transaction = WagerTransaction.createOpening(buildOpeningProps({ idempotencyKey: "internal:wallet-1" }));

    expect(transaction.providerId).toBeUndefined();
    expect(transaction.externalTransactionId).toBeUndefined();
    expect(transaction.roundId).toBeUndefined();
    expect(transaction.gameId).toBeUndefined();
    expect(transaction.payloadHash).toBeUndefined();
    expect(transaction.idempotencyKey).toBe("internal:wallet-1");
  });

  test("markProcessed over a PENDING transaction moves it to PROCESSED and records the reference and processedAt", () => {
    const transaction = WagerTransaction.create(buildProps({ kind: "BET" }));
    const at = new Date("2026-01-01T00:00:00.000Z");

    transaction.markProcessed(undefined, at);

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.processedAt).toEqual(at);
  });

  test("markProcessed over a PENDING_REFERENCE transaction moves it to PROCESSED and records the reference and processedAt", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    transaction.markPendingReference();
    const at = new Date("2026-01-02T00:00:00.000Z");

    transaction.markProcessed("resolved-tx-1", at);

    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.referenceTransactionId).toBe("resolved-tx-1");
    expect(transaction.processedAt).toEqual(at);
  });

  test("reject over a PENDING transaction moves it to REJECTED and records the failureCode", () => {
    const transaction = WagerTransaction.create(buildProps({ kind: "BET" }));

    transaction.reject("INSUFFICIENT_FUNDS");

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  test("reject over a PENDING_REFERENCE transaction moves it to REJECTED and records the failureCode", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    transaction.markPendingReference();

    transaction.reject("REFERENCE_NOT_FOUND");

    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
  });

  test("fail over a PENDING transaction moves it to FAILED and records the failureCode", () => {
    const transaction = WagerTransaction.create(buildProps({ kind: "BET" }));

    transaction.fail("INTERNAL_ERROR");

    expect(transaction.status).toBe("FAILED");
    expect(transaction.failureCode).toBe("INTERNAL_ERROR");
  });

  test("markPendingReference over a PENDING transaction moves it to PENDING_REFERENCE", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );

    transaction.markPendingReference();

    expect(transaction.status).toBe("PENDING_REFERENCE");
  });

  test("every transition throws InvalidTransactionStateError without mutating a terminal transaction, for all 3 terminal statuses and all 4 transition methods", () => {
    const terminalStatuses: WagerTransactionStatus[] = ["PROCESSED", "REJECTED", "FAILED"];
    for (const status of terminalStatuses) {
      const transaction = buildTerminalTransaction(status);
      const before = snapshotOf(transaction);

      expect(() => transaction.markProcessed("other-tx", new Date())).toThrow(InvalidTransactionStateError);
      expect(snapshotOf(transaction)).toEqual(before);

      expect(() => transaction.reject("SOME_CODE")).toThrow(InvalidTransactionStateError);
      expect(snapshotOf(transaction)).toEqual(before);

      expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(snapshotOf(transaction)).toEqual(before);

      expect(() => transaction.fail("SOME_CODE")).toThrow(InvalidTransactionStateError);
      expect(snapshotOf(transaction)).toEqual(before);
    }
  });

  test("fail over a PENDING_REFERENCE transaction throws InvalidTransactionStateError without mutating it", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    transaction.markPendingReference();
    const before = snapshotOf(transaction);

    expect(() => transaction.fail("SOME_CODE")).toThrow(InvalidTransactionStateError);
    expect(snapshotOf(transaction)).toEqual(before);
  });

  test("markPendingReference over a PENDING_REFERENCE transaction throws InvalidTransactionStateError without mutating it", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    transaction.markPendingReference();
    const before = snapshotOf(transaction);

    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(snapshotOf(transaction)).toEqual(before);
  });

  test("isTerminal returns true only for PROCESSED, REJECTED and FAILED, and false for PENDING and PENDING_REFERENCE", () => {
    const pending = WagerTransaction.create(buildProps({ kind: "BET" }));
    expect(pending.isTerminal()).toBe(false);

    const pendingReference = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    pendingReference.markPendingReference();
    expect(pendingReference.isTerminal()).toBe(false);

    expect(buildTerminalTransaction("PROCESSED").isTerminal()).toBe(true);
    expect(buildTerminalTransaction("REJECTED").isTerminal()).toBe(true);
    expect(buildTerminalTransaction("FAILED").isTerminal()).toBe(true);
  });

  test("affectsBalance returns false only for LOSS and true for every other kind", () => {
    expect(WagerTransaction.create(buildProps({ kind: "LOSS" })).affectsBalance()).toBe(false);

    const otherKinds: WagerTransactionKind[] = ["BET", "WIN", "REFUND", "ROLLBACK"];
    for (const kind of otherKinds) {
      const transaction = WagerTransaction.create(buildProps({ kind, referenceExternalTransactionId: "ext-ref-1" }));
      expect(transaction.affectsBalance()).toBe(true);
    }
    expect(WagerTransaction.createOpening(buildOpeningProps()).affectsBalance()).toBe(true);
  });

  test("requiresReference returns true only for REFUND and ROLLBACK", () => {
    for (const kind of ["REFUND", "ROLLBACK"] as WagerTransactionKind[]) {
      const transaction = WagerTransaction.create(buildProps({ kind, referenceExternalTransactionId: "ext-ref-1" }));
      expect(transaction.requiresReference()).toBe(true);
    }
    for (const kind of ["BET", "WIN", "LOSS"] as WagerTransactionKind[]) {
      expect(WagerTransaction.create(buildProps({ kind })).requiresReference()).toBe(false);
    }
    expect(WagerTransaction.createOpening(buildOpeningProps()).requiresReference()).toBe(false);
  });

  test("matchesPayload returns true for the exact hash used at creation", () => {
    const transaction = WagerTransaction.create(buildProps({ payloadHash: "hash-abc" }));
    expect(transaction.matchesPayload("hash-abc")).toBe(true);
  });

  test("matchesPayload returns false for a different hash", () => {
    const transaction = WagerTransaction.create(buildProps({ payloadHash: "hash-abc" }));
    expect(transaction.matchesPayload("hash-xyz")).toBe(false);
  });

  test("ledgerDirectionFor returns DEBIT for BET", () => {
    const transaction = WagerTransaction.create(buildProps({ kind: "BET" }));
    expect(transaction.ledgerDirectionFor()).toBe("DEBIT");
  });

  test("ledgerDirectionFor returns CREDIT for WIN, REFUND and OPENING", () => {
    const win = WagerTransaction.create(buildProps({ kind: "WIN" }));
    expect(win.ledgerDirectionFor()).toBe("CREDIT");

    const refund = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-1" }),
    );
    expect(refund.ledgerDirectionFor()).toBe("CREDIT");

    const opening = WagerTransaction.createOpening(buildOpeningProps());
    expect(opening.ledgerDirectionFor()).toBe("CREDIT");
  });

  test("ledgerDirectionFor returns CREDIT for a ROLLBACK referencing a BET", () => {
    const bet = WagerTransaction.create(buildProps({ kind: "BET" }));
    const rollback = WagerTransaction.create(
      buildProps({ kind: "ROLLBACK", referenceExternalTransactionId: "ext-ref-1" }),
    );

    expect(rollback.ledgerDirectionFor(bet)).toBe("CREDIT");
  });

  test("ledgerDirectionFor returns DEBIT for a ROLLBACK referencing a WIN or a REFUND", () => {
    const win = WagerTransaction.create(buildProps({ kind: "WIN" }));
    const rollbackOfWin = WagerTransaction.create(
      buildProps({ kind: "ROLLBACK", referenceExternalTransactionId: "ext-ref-1" }),
    );
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe("DEBIT");

    const refund = WagerTransaction.create(
      buildProps({ kind: "REFUND", referenceExternalTransactionId: "ext-ref-2" }),
    );
    const rollbackOfRefund = WagerTransaction.create(
      buildProps({ kind: "ROLLBACK", referenceExternalTransactionId: "ext-ref-3" }),
    );
    expect(rollbackOfRefund.ledgerDirectionFor(refund)).toBe("DEBIT");
  });

  test("ledgerDirectionFor throws LedgerDirectionNotApplicableError for LOSS", () => {
    const transaction = WagerTransaction.create(buildProps({ kind: "LOSS" }));
    expect(() => transaction.ledgerDirectionFor()).toThrow(LedgerDirectionNotApplicableError);
  });

  test("ledgerDirectionFor throws LedgerDirectionNotApplicableError for a ROLLBACK without a reference", () => {
    const transaction = WagerTransaction.create(
      buildProps({ kind: "ROLLBACK", referenceExternalTransactionId: "ext-ref-1" }),
    );
    expect(() => transaction.ledgerDirectionFor()).toThrow(LedgerDirectionNotApplicableError);
  });

  test("rehydrate reconstructs the exact state passed, without throwing", () => {
    const state: WagerTransactionState = {
      id: "tx-1",
      providerId: "provider-1",
      externalTransactionId: "ext-1",
      idempotencyKey: "idem-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "ROLLBACK",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: "ext-ref-1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "PROCESSED",
      referenceTransactionId: "resolved-tx-1",
      failureCode: "SOME_CODE",
      processedAt: new Date("2026-01-01T00:05:00.000Z"),
    };

    const transaction = WagerTransaction.rehydrate(state);

    expect(transaction.id).toBe(state.id);
    expect(transaction.providerId).toBe(state.providerId);
    expect(transaction.externalTransactionId).toBe(state.externalTransactionId);
    expect(transaction.idempotencyKey).toBe(state.idempotencyKey);
    expect(transaction.payloadHash).toBe(state.payloadHash);
    expect(transaction.walletId).toBe(state.walletId);
    expect(transaction.playerId).toBe(state.playerId);
    expect(transaction.roundId).toBe(state.roundId);
    expect(transaction.gameId).toBe(state.gameId);
    expect(transaction.kind).toBe(state.kind);
    expect(transaction.money).toBe(state.money);
    expect(transaction.referenceExternalTransactionId).toBe(state.referenceExternalTransactionId);
    expect(transaction.createdAt).toEqual(state.createdAt);
    expect(transaction.status).toBe(state.status);
    expect(transaction.referenceTransactionId).toBe(state.referenceTransactionId);
    expect(transaction.failureCode).toBe(state.failureCode);
    expect(transaction.processedAt).toEqual(state.processedAt);
  });

  test("rehydrate reconstructs a state that would violate create's invariants, without throwing any validation error", () => {
    const invalidState: WagerTransactionState = {
      id: "tx-1",
      providerId: "provider-1",
      externalTransactionId: "ext-1",
      idempotencyKey: "idem-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "OPENING",
      money: Money.from({ amount: "100.00", currency: "BRL" }),
      referenceExternalTransactionId: undefined,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "PROCESSED",
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(() => WagerTransaction.rehydrate(invalidState)).not.toThrow();

    const transaction = WagerTransaction.rehydrate(invalidState);
    expect(transaction.kind).toBe("OPENING");
    expect(transaction.status).toBe("PROCESSED");
  });
});
