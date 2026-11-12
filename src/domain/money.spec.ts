import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyAmountError, Money } from "./money";

describe("Money", () => {
  test("constructs a valid instance from a well-formed two-decimal amount", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });

    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("rejects more than two decimal places, accepts zero or one", () => {
    expect(() => Money.from({ amount: "25.001", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "25.000", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(Money.from({ amount: "25.0", currency: "BRL" }).toJSON().amount).toBe("25.00");
    expect(Money.from({ amount: "25", currency: "BRL" }).toJSON().amount).toBe("25.00");
  });

  test("rejects NaN, Infinity, scientific notation and an empty string", () => {
    for (const amount of ["NaN", "Infinity", "1e10", ""]) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    }
  });

  test("rejects a negative amount unless negative values are explicitly allowed", () => {
    expect(() => Money.from({ amount: "-0.01", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
  });

  test("accepts a negative amount when allowNegative is explicitly set", () => {
    const money = Money.from({ amount: "-0.01", currency: "BRL" }, { allowNegative: true });

    expect(money.toJSON().amount).toBe("-0.01");
  });

  test("zero returns a zero amount for the given currency", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test("accepts a negative-signed zero string as zero, without requiring allowNegative", () => {
    const negativeZero = Money.from({ amount: "-0.00", currency: "BRL" });

    expect(negativeZero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(negativeZero.equals(Money.zero("BRL"))).toBe(true);
  });

  test("add, subtract and negate each return a new instance, leaving the original unchanged", () => {
    const original = Money.from({ amount: "25.00", currency: "BRL" });
    const ten = Money.from({ amount: "10.00", currency: "BRL" });

    const added = original.add(ten);
    expect(added).not.toBe(original);
    expect(original.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });

    const subtracted = original.subtract(ten);
    expect(subtracted).not.toBe(original);
    expect(original.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });

    const negated = original.negate();
    expect(negated).not.toBe(original);
    expect(original.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("add and subtract throw CurrencyMismatchError between different currencies", () => {
    const brl = Money.from({ amount: "25.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(brl.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(usd.toJSON()).toEqual({ amount: "10.00", currency: "USD" });
  });

  test("subtract and negate can legitimately produce a negative instance without a validation error", () => {
    const ten = Money.from({ amount: "10.00", currency: "BRL" });
    const twentyFive = Money.from({ amount: "25.00", currency: "BRL" });

    const subtracted = ten.subtract(twentyFive);
    expect(subtracted.toJSON().amount).toBe("-15.00");
    expect(subtracted.isNegative()).toBe(true);

    const negated = twentyFive.negate();
    expect(negated.toJSON().amount).toBe("-25.00");
    expect(negated.isNegative()).toBe(true);
  });

  test("isZero, isPositive and isNegative reflect the exact sign, with zero neither positive nor negative", () => {
    const zero = Money.zero("BRL");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    const positive = Money.from({ amount: "10.00", currency: "BRL" });
    expect(positive.isZero()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);

    const negative = Money.from({ amount: "-10.00", currency: "BRL" }, { allowNegative: true });
    expect(negative.isZero()).toBe(false);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isNegative()).toBe(true);
  });

  test("isLessThan throws CurrencyMismatchError between different currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("equals returns true for the same amount and currency", () => {
    const a = Money.from({ amount: "10.00", currency: "BRL" });
    const b = Money.from({ amount: "10.00", currency: "BRL" });

    expect(a.equals(b)).toBe(true);
  });

  test("equals returns false for a different amount or a different currency, never throwing", () => {
    const base = Money.from({ amount: "10.00", currency: "BRL" });
    const differentAmount = Money.from({ amount: "10.01", currency: "BRL" });
    const differentCurrency = Money.from({ amount: "10.00", currency: "USD" });

    expect(base.equals(differentAmount)).toBe(false);
    expect(() => base.equals(differentCurrency)).not.toThrow();
    expect(base.equals(differentCurrency)).toBe(false);
  });

  test("toJSON always returns amount with exactly two decimal places, even after an operation drops trailing zeros", () => {
    const ten = Money.from({ amount: "10.00", currency: "BRL" });
    const fifteen = Money.from({ amount: "15.00", currency: "BRL" });

    const sum = ten.add(fifteen);

    expect(sum.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("toString always includes amount with two decimal places and the currency", () => {
    const ten = Money.from({ amount: "10.00", currency: "BRL" });
    const fifteen = Money.from({ amount: "15.00", currency: "BRL" });

    const sum = ten.add(fifteen);

    expect(sum.toString()).toBe("25.00 BRL");
  });
});
