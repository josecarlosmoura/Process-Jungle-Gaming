import { Migration } from "@mikro-orm/migrations";

export class Migration20261113140000_WagerTransactionsBalanceAfterProcessing extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "balance_after_amount" numeric(19,2) null,
        add column "balance_after_currency" char(3) null;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_balance_after_pair_check" check (
          ("balance_after_amount" is null) = ("balance_after_currency" is null)
        ),
        add constraint "wager_transactions_balance_after_currency_format" check (
          "balance_after_currency" ~ '^[A-Z]{3}$'
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_balance_after_currency_format",
        drop constraint "wager_transactions_balance_after_pair_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
        drop column "balance_after_currency",
        drop column "balance_after_amount";
    `);
  }
}
