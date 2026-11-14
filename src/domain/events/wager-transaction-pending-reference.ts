import { randomUUID } from "node:crypto";
import type { EventContext, IntegrationEventProps } from "../integration-event";
import { IntegrationEvent } from "../integration-event";
import type { ReversalKind, WagerTransaction } from "../wager-transaction";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  kind: ReversalKind;
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  // So chamado depois de transaction.markPendingReference(now) - attempts/nextAttemptAt e
  // referenceExternalTransactionId sempre presentes nesse ponto (REFUND/ROLLBACK exigem a
  // referencia na criacao).
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: randomUUID(),
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        kind: transaction.kind as ReversalKind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId as string,
        attempts: transaction.attempts as number,
        nextAttemptAt: (transaction.nextAttemptAt as Date).toISOString(),
      },
    });
  }
}
