import type { Money } from "./money";
import type { LedgerDirection } from "./wager-transaction";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class UnbalancedLedgerEntryError extends Error {
  constructor(direction: LedgerDirection, balanceBefore: Money, money: Money, balanceAfter: Money) {
    super(
      `Ledger entry is not balanced: ${direction} ${money.toString()} over balanceBefore ${balanceBefore.toString()} does not yield balanceAfter ${balanceAfter.toString()}`,
    );
    this.name = "UnbalancedLedgerEntryError";
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const expectedBalanceAfter = WalletLedgerEntry.applyDirection(props.direction, props.balanceBefore, props.money);
    if (!expectedBalanceAfter.equals(props.balanceAfter)) {
      throw new UnbalancedLedgerEntryError(props.direction, props.balanceBefore, props.money, props.balanceAfter);
    }
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(),
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    try {
      return WalletLedgerEntry.applyDirection(this.direction, this.balanceBefore, this.money).equals(this.balanceAfter);
    } catch {
      // Só alcançável via rehydrate de um estado persistido com moedas divergentes entre
      // balanceBefore/money - create já teria rejeitado isso. Reconciliação (T304) precisa de
      // um booleano para reportar a linha inconsistente, nunca de uma exceção não tratada.
      return false;
    }
  }

  private static applyDirection(direction: LedgerDirection, balanceBefore: Money, money: Money): Money {
    return direction === "DEBIT" ? balanceBefore.subtract(money) : balanceBefore.add(money);
  }
}
