import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "wager_transactions" })
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  // Nullable so que exatamente quando kind = "OPENING" - a constraint de banco
  // (wager_transactions_opening_fields_null_check) garante o inverso para qualquer outro kind.
  @Property({ fieldName: "provider_id", type: "text", nullable: true })
  providerId?: string;

  @Property({ fieldName: "external_transaction_id", type: "text", nullable: true })
  externalTransactionId?: string;

  @Property({ fieldName: "idempotency_key", type: "text" })
  idempotencyKey!: string;

  @Property({ fieldName: "payload_hash", type: "text", nullable: true })
  payloadHash?: string;

  // Coluna escalar simples, nunca @ManyToOne: Wallet e WagerTransaction são agregados
  // distintos, referenciados só por id.
  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "player_id", type: "text" })
  playerId!: string;

  @Property({ fieldName: "round_id", type: "text", nullable: true })
  roundId?: string;

  @Property({ fieldName: "game_id", type: "text", nullable: true })
  gameId?: string;

  @Property({ type: "text" })
  kind!: string;

  @Property({ fieldName: "money_amount", type: "string", columnType: "numeric(19,2)" })
  moneyAmount!: string;

  @Property({ fieldName: "money_currency", type: "string", length: 3 })
  moneyCurrency!: string;

  @Property({ fieldName: "reference_external_transaction_id", type: "text", nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: "text" })
  status!: string;

  @Property({ fieldName: "reference_transaction_id", type: "uuid", nullable: true })
  referenceTransactionId?: string;

  @Property({ fieldName: "failure_code", type: "text", nullable: true })
  failureCode?: string;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;

  @Property({ fieldName: "processed_at", nullable: true })
  processedAt?: Date;
}
