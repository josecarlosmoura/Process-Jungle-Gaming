import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "player_id", type: "text" })
  playerId!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  // Nunca "number" aqui - string preserva a escala exata da coluna numeric(19,2) sem o erro de
  // ponto flutuante que um número JS introduziria.
  @Property({ fieldName: "balance_amount", type: "string", columnType: "numeric(19,2)" })
  balanceAmount!: string;

  // Sem @Version(): o incremento é decidido pelo domínio (Wallet.debit/credit), nunca pelo MikroORM.
  @Property({ type: "number" })
  version!: number;

  @Property({ fieldName: "created_at" })
  createdAt!: Date;

  @Property({ fieldName: "updated_at" })
  updatedAt!: Date;
}
