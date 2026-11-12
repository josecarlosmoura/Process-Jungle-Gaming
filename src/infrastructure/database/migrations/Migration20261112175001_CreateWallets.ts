import { Migration } from "@mikro-orm/migrations";

export class Migration20261112175001_CreateWallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" text not null,
        "currency" char(3) not null,
        "balance_amount" numeric(19,2) not null,
        "version" int4 not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_id_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_amount_non_negative" check ("balance_amount" >= 0),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
