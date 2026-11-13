import { CurrencyMismatchError, type Money } from "./money";

export interface WalletOpenProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends Error {
  constructor(walletId: string, balance: Money, requested: Money) {
    super(`Wallet "${walletId}" has insufficient funds: balance ${balance.toString()}, requested ${requested.toString()}`);
    this.name = "InsufficientFundsError";
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for playerId "${playerId}" and currency "${currency}"`);
    this.name = "WalletAlreadyExistsError";
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" was not found`);
    this.name = "WalletNotFoundError";
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: WalletOpenProps): Wallet {
    const now = new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance, 1, now, now);
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get currency(): string {
    return this._balance.currency;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money): void {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(this.id, this._balance, money);
    }
    this._balance = this._balance.subtract(money);
    // RN-10: version só incrementa quando o saldo de fato muda - um débito/crédito de valor zero é aceito, mas não é uma mudança de saldo.
    if (!money.isZero()) {
      this.touch();
    }
  }

  credit(money: Money): void {
    this.assertSameCurrency(money);
    this._balance = this._balance.add(money);
    if (!money.isZero()) {
      this.touch();
    }
  }

  private touch(): void {
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
