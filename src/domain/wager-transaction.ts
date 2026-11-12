import type { Money } from "./money";

export type WagerTransactionKind = "OPENING" | "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";

export type WagerTransactionStatus = "PENDING" | "PENDING_REFERENCE" | "PROCESSED" | "REJECTED" | "FAILED";

export type LedgerDirection = "DEBIT" | "CREDIT";

export type FailureCode = string;

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

export type CreateOpeningWagerTransactionProps = Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">;

export interface WagerTransactionState {
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
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
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
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
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
    return WagerTransaction.instantiate(props.kind, props.referenceExternalTransactionId, props);
  }

  static createOpening(props: CreateOpeningWagerTransactionProps): WagerTransaction {
    return WagerTransaction.instantiate("OPENING", undefined, props);
  }

  private static instantiate(
    kind: WagerTransactionKind,
    referenceExternalTransactionId: string | undefined,
    props: CreateOpeningWagerTransactionProps,
  ): WagerTransaction {
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
      kind,
      props.money,
      referenceExternalTransactionId,
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

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertTransitionAllowed("markProcessed", ["PENDING", "PENDING_REFERENCE"]);
    this._status = "PROCESSED";
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
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
        // RN-26: ROLLBACK aplica o efeito inverso ao da transação original.
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
