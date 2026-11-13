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

    // Qualquer linha OPENING ja persistida tem os 5 campos NULL (e e exatamente o que esta
    // migration existe para permitir) - "set not null" abaixo rejeitaria o down() caso uma
    // dessas linhas ainda exista. down() aqui e so para desfazer o schema em ambiente de
    // desenvolvimento/teste, nunca uma migracao de dados para producao (mesma postura das
    // outras migrations deste diretorio, cujo down() tambem descarta dados via DROP TABLE
    // CASCADE) - por isso qualquer OPENING e seu lancamento de ledger sao descartados aqui.
    this.addSql(`
      delete from "wallet_ledger_entries"
      where "transaction_id" in (select "id" from "wager_transactions" where "kind" = 'OPENING');
    `);
    this.addSql(`delete from "wager_transactions" where "kind" = 'OPENING';`);

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
