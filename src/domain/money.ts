import { Decimal } from "decimal.js";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export interface MoneyFromOptions {
  allowNegative?: boolean;
}

export class InvalidMoneyAmountError extends Error {
  constructor(amount: string) {
    super(`Invalid money amount: "${amount}"`);
    this.name = "InvalidMoneyAmountError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Currency mismatch: "${left}" vs "${right}"`);
    this.name = "CurrencyMismatchError";
  }
}

// RN-02: no more than 2 decimal digits; 0 or 1 is accepted and normalized on output.
// Anchored end-to-end so it also rejects "NaN", "Infinity", scientific notation and "".
const AMOUNT_FORMAT = /^-?\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps, options: MoneyFromOptions = {}): Money {
    const { amount, currency } = props;
    if (!AMOUNT_FORMAT.test(amount)) {
      throw new InvalidMoneyAmountError(amount);
    }
    const value = new Decimal(amount);
    // decimal.js preserva o sinal de "-0.00" (isNegative() = true mesmo com valor zero);
    // sem excluir isZero() aqui, essa string seria rejeitada mesmo representando o mesmo
    // valor que "0.00" (aceito).
    if (!value.isZero() && value.isNegative() && !options.allowNegative) {
      throw new InvalidMoneyAmountError(amount);
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return !this.value.isZero() && this.value.isPositive();
  }

  isNegative(): boolean {
    return !this.value.isZero() && this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
