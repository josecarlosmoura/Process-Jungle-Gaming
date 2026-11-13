import { createHash } from "node:crypto";
import type { Money } from "../../domain/money";
import type { WagerTransactionKind } from "../../domain/wager-transaction";

export interface WagerTransactionBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export function canonicalWagerTransactionPayload(payload: WagerTransactionBusinessPayload): string {
  const entries: Array<[string, unknown]> = [
    ["externalTransactionId", payload.externalTransactionId],
    ["gameId", payload.gameId],
    ["kind", payload.kind],
    ["money", payload.money.toJSON()],
    ["playerId", payload.playerId],
    ["providerId", payload.providerId],
    ["roundId", payload.roundId],
    ["walletId", payload.walletId],
  ];
  if (payload.referenceExternalTransactionId !== undefined) {
    entries.push(["referenceExternalTransactionId", payload.referenceExternalTransactionId]);
    entries.sort(([a], [b]) => a.localeCompare(b));
  }
  return JSON.stringify(Object.fromEntries(entries));
}

export function computeWagerTransactionPayloadHash(payload: WagerTransactionBusinessPayload): string {
  return createHash("sha256").update(canonicalWagerTransactionPayload(payload)).digest("hex");
}
