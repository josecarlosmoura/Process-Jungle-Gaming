import type { FailureCode } from "./failure-code";
import type { Money } from "./money";

export type WagerTransactionKind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

export type ReversalKind = "REFUND" | "ROLLBACK";

export type WagerTransactionStatus = "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";

export type LedgerDirection = "DEBIT" | "CREDIT";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface CreateOpeningWagerTransactionProps {
  id: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  money: Money;
}

export interface WagerTransactionState {
  id: string;
  // Ausentes (undefined) exatamente quando kind = "OPENING": essa transação é gerada
  // internamente, sem provedor/rodada/jogo reais por tras - a constraint de banco garante o
  // inverso (NOT NULL para qualquer outro kind).
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfterProcessing?: Money;
}

const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set(["REFUND", "ROLLBACK"]);

export class InvalidWagerTransactionPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionPayloadError";
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(transactionId: string, from: WagerTransactionStatus, transition: string) {
    super(`WagerTransaction "${transactionId}" cannot "${transition}" from status "${from}"`);
    this.name = "InvalidTransactionStateError";
  }
}

export class LedgerDirectionNotApplicableError extends Error {
  constructor(transactionId: string, kind: WagerTransactionKind) {
    super(`WagerTransaction "${transactionId}" of kind "${kind}" has no applicable ledger direction`);
    this.name = "LedgerDirectionNotApplicableError";
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string | undefined,
    public readonly externalTransactionId: string | undefined,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string | undefined,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    // Só populado por markProcessed() quando affectsBalance() e false (hoje, so LOSS) - esses
    // kinds nunca ganham um WalletLedgerEntry, entao nao ha outro lugar que congele o saldo
    // observado no momento do processamento para um replay futuro.
    private _balanceAfterProcessing?: Money,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === "OPENING") {
      throw new InvalidWagerTransactionPayloadError(
        'kind "OPENING" cannot be created through the public create() factory - use createOpening() instead',
      );
    }
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionPayloadError(
        `kind "${props.kind}" requires a non-empty referenceExternalTransactionId`,
      );
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      "PENDING",
    );
  }

  static createOpening(props: CreateOpeningWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      props.idempotencyKey,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      "OPENING",
      props.money,
      undefined,
      new Date(),
      "PENDING",
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfterProcessing,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfterProcessing(): Money | undefined {
    return this._balanceAfterProcessing;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfterProcessing?: Money): void {
    this.assertTransitionAllowed("markProcessed", ["PENDING", "PENDING_REFERENCE"]);
    this._status = "PROCESSED";
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfterProcessing = balanceAfterProcessing;
  }

  markPendingReference(): void {
    this.assertTransitionAllowed("markPendingReference", ["PENDING"]);
    this._status = "PENDING_REFERENCE";
  }

  reject(code: FailureCode): void {
    this.assertTransitionAllowed("reject", ["PENDING", "PENDING_REFERENCE"]);
    this._status = "REJECTED";
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode): void {
    this.assertTransitionAllowed("fail", ["PENDING"]);
    this._status = "FAILED";
    this._failureCode = code;
    this._processedAt = new Date();
  }

  isTerminal(): boolean {
    return this._status === "PROCESSED" || this._status === "REJECTED" || this._status === "FAILED";
  }

  affectsBalance(): boolean {
    return this.kind !== "LOSS";
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case "BET":
        return "DEBIT";
      case "WIN":
      case "REFUND":
      case "OPENING":
        return "CREDIT";
      case "ROLLBACK":
        if (!reference) {
          throw new LedgerDirectionNotApplicableError(this.id, this.kind);
        }
        // ROLLBACK aplica o efeito inverso ao da transação original.
        return reference.ledgerDirectionFor() === "DEBIT" ? "CREDIT" : "DEBIT";
      case "LOSS":
        throw new LedgerDirectionNotApplicableError(this.id, this.kind);
    }
  }

  private assertTransitionAllowed(transition: string, allowedSources: readonly WagerTransactionStatus[]): void {
    if (!allowedSources.includes(this._status)) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }
}
