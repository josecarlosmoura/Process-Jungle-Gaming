import { Migration } from "@mikro-orm/migrations";

export class Migration20261112222253_CreateWalletLedgerEntries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" text not null,
        "money_amount" numeric(19,2) not null,
        "money_currency" char(3) not null,
        "balance_before_amount" numeric(19,2) not null,
        "balance_after_amount" numeric(19,2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_id_transaction_id_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_money_currency_format" check ("money_currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_entries_balance_arithmetic_check" check (
          ("direction" = 'DEBIT' and "balance_before_amount" - "money_amount" = "balance_after_amount")
          or ("direction" = 'CREDIT' and "balance_before_amount" + "money_amount" = "balance_after_amount")
        ),
        constraint "wallet_ledger_entries_wallet_id_fkey" foreign key ("wallet_id") references "wallets" ("id") on delete restrict,
        constraint "wallet_ledger_entries_transaction_id_fkey" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }
}
