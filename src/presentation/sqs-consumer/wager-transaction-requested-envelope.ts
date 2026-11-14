import { z } from "zod";
import type { ProcessWagerTransactionCommand } from "../../application/use-cases/process-wager-transaction.use-case";
import { PayloadValidationError } from "../../domain/domain-error";
import { Money } from "../../domain/money";

// Mesma regra de borda que WageringController ja aplica para o corpo HTTP (RF-05/T204/T205): a
// ausencia de referencia aqui vira um erro de payload (ack direto, nunca retry), nunca alcanca
// WagerTransaction.create().
const KINDS_REQUIRING_REFERENCE: ReadonlySet<string> = new Set(["REFUND", "ROLLBACK"]);

const wagerTransactionRequestedDataSchema = z
  .object({
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    playerId: z.string().min(1),
    walletId: z.string().uuid(),
    roundId: z.string().min(1),
    gameId: z.string().min(1),
    kind: z.string().min(1),
    money: z.object({
      amount: z.string(),
      currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code"),
    }),
    referenceExternalTransactionId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (KINDS_REQUIRING_REFERENCE.has(data.kind) && !data.referenceExternalTransactionId) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `referenceExternalTransactionId is required for kind "${data.kind}"`,
      });
    }
  });

// Documents/Instructions/README.md secao 10 - o mesmo shape literal usado na validacao manual de
// Documents/Tasks/.../T210-SQS-Consumer.md.
const wagerTransactionRequestedEnvelopeSchema = z.object({
  messageId: z.string().min(1),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().min(1),
  data: wagerTransactionRequestedDataSchema,
});

export type WagerTransactionRequestedEnvelope = z.infer<typeof wagerTransactionRequestedEnvelopeSchema>;

export class InvalidWagerTransactionEnvelopeError extends PayloadValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionEnvelopeError";
  }
}

export function parseWagerTransactionRequestedEnvelope(body: string): WagerTransactionRequestedEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new InvalidWagerTransactionEnvelopeError(
      `message body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = wagerTransactionRequestedEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new InvalidWagerTransactionEnvelopeError(`message body does not match the expected envelope - ${issues}`);
  }
  return parsed.data;
}

export function toProcessWagerTransactionCommand(envelope: WagerTransactionRequestedEnvelope): ProcessWagerTransactionCommand {
  return {
    idempotencyKey: envelope.data.idempotencyKey,
    providerId: envelope.data.providerId,
    externalTransactionId: envelope.data.externalTransactionId,
    playerId: envelope.data.playerId,
    walletId: envelope.data.walletId,
    roundId: envelope.data.roundId,
    gameId: envelope.data.gameId,
    kind: envelope.data.kind,
    money: Money.from(envelope.data.money),
    referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
  };
}
