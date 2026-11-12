import { Migration } from "@mikro-orm/migrations";

export class Migration20261112192841_CreateWagerTransactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" text not null,
        "wallet_id" uuid not null,
        "player_id" text not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" text not null,
        "money_amount" numeric(19,2) not null,
        "money_currency" char(3) not null,
        "reference_external_transaction_id" text null,
        "status" text not null default 'PENDING',
        "reference_transaction_id" uuid null,
        "failure_code" text null,
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_transactions_provider_id_external_transaction_id_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_money_currency_format" check ("money_currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_wallet_id_fkey" foreign key ("wallet_id") references "wallets" ("id") on delete restrict,
        constraint "wager_transactions_reference_transaction_id_fkey" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict
      );
    `);

    this.addSql(`
      create index "wager_transactions_provider_reference_idx"
      on "wager_transactions" ("provider_id", "reference_external_transaction_id");
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }
}
