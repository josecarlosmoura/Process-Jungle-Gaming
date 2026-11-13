import { Migration } from "@mikro-orm/migrations";

export class Migration20261113090000_WagerTransactionsOpeningFieldsNullable extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        alter column "provider_id" drop not null,
        alter column "external_transaction_id" drop not null,
        alter column "round_id" drop not null,
        alter column "game_id" drop not null,
        alter column "payload_hash" drop not null;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_opening_fields_null_check" check (
          (
            "kind" = 'OPENING'
            and "provider_id" is null
            and "external_transaction_id" is null
            and "round_id" is null
            and "game_id" is null
            and "payload_hash" is null
          )
          or
          (
            "kind" <> 'OPENING'
            and "provider_id" is not null
            and "external_transaction_id" is not null
            and "round_id" is not null
            and "game_id" is not null
            and "payload_hash" is not null
          )
        );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_opening_fields_null_check";`);

    this.addSql(`
      alter table "wager_transactions"
        alter column "provider_id" set not null,
        alter column "external_transaction_id" set not null,
        alter column "round_id" set not null,
        alter column "game_id" set not null,
        alter column "payload_hash" set not null;
    `);
  }
}
