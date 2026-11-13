import { Migration } from "@mikro-orm/migrations";

export class Migration20261113160000_WagerTransactionsPendingReferenceMetadata extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "attempts" int null,
        add column "next_attempt_at" timestamptz null;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_pending_reference_metadata_pair_check" check (
          ("attempts" is null) = ("next_attempt_at" is null)
        ),
        add constraint "wager_transactions_attempts_non_negative_check" check (
          "attempts" is null or "attempts" >= 0
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        drop constraint "wager_transactions_attempts_non_negative_check",
        drop constraint "wager_transactions_pending_reference_metadata_pair_check";
    `);

    this.addSql(`
      alter table "wager_transactions"
        drop column "next_attempt_at",
        drop column "attempts";
    `);
  }
}
