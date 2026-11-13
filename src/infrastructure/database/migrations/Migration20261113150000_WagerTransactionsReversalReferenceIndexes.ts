import { Migration } from "@mikro-orm/migrations";

export class Migration20261113150000_WagerTransactionsReversalReferenceIndexes extends Migration {
  override async up(): Promise<void> {
    // A mesma referência não pode receber duas REFUND nem dois ROLLBACK - mas pode receber um
    // REFUND e um ROLLBACK, e qualquer número de WIN (não é reversão, sem essa restrição). Um
    // único índice sem o filtro por "kind" bloquearia as duas combinações permitidas; por isso
    // são dois índices parciais, um por tipo de reversão.
    this.addSql(`
      create unique index "wager_transactions_refund_reference_unique"
      on "wager_transactions" ("reference_transaction_id")
      where "kind" = 'REFUND' and "reference_transaction_id" is not null;
    `);

    this.addSql(`
      create unique index "wager_transactions_rollback_reference_unique"
      on "wager_transactions" ("reference_transaction_id")
      where "kind" = 'ROLLBACK' and "reference_transaction_id" is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index "wager_transactions_rollback_reference_unique";`);
    this.addSql(`drop index "wager_transactions_refund_reference_unique";`);
  }
}
