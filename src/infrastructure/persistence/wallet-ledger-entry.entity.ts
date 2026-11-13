import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "wallet_ledger_entries" })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "transaction_id", type: "uuid" })
  transactionId!: string;

  @Property({ type: "text" })
  direction!: string;

  @Property({ fieldName: "money_amount", type: "string", columnType: "numeric(19,2)" })
  moneyAmount!: string;

  @Property({ fieldName: "money_currency", type: "string", length: 3 })
  moneyCurrency!: string;

  @Property({ fieldName: "balance_before_amount", type: "string", columnType: "numeric(19,2)" })
  balanceBeforeAmount!: string;

  @Property({ fieldName: "balance_after_amount", type: "string", columnType: "numeric(19,2)" })
  balanceAfterAmount!: string;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;
}
