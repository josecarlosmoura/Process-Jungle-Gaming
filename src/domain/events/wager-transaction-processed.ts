import { randomUUID } from "node:crypto";
import type { EventContext, IntegrationEventProps } from "../integration-event";
import { IntegrationEvent } from "../integration-event";
import type { MoneyProps } from "../money";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction";

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  // aggregateId e sempre o walletId (ARCHITECTURE.md secao 7 - MessageGroupId do SQS FIFO), nunca
  // o id da propria WagerTransaction.
  static from(transaction: WagerTransaction, balance: MoneyProps, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceTransactionId: transaction.referenceTransactionId,
        balance,
      },
    });
  }
}
