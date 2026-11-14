import { randomUUID } from "node:crypto";
import type { FailureCode } from "../failure-code";
import type { EventContext, IntegrationEventProps } from "../integration-event";
import { IntegrationEvent } from "../integration-event";
import type { MoneyProps } from "../money";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction";

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  // So chamado depois de transaction.reject(code) - failureCode sempre presente nesse ponto.
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode: transaction.failureCode as FailureCode,
      },
    });
  }
}
