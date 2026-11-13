import { createHmac, timingSafeEqual } from "node:crypto";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";

export const WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE = Symbol("WalletLedgerEntryRepository");

export interface LedgerPagination {
  cursor?: string;
  limit: number;
}

export interface WalletLedgerEntryRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(walletId: string, pagination: LedgerPagination): Promise<WalletLedgerEntry[]>;
}

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export class InvalidLedgerCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid ledger cursor: ${reason}`);
    this.name = "InvalidLedgerCursorError";
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeLedgerCursor(entry: Pick<WalletLedgerEntry, "createdAt" | "id">, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ createdAt: entry.createdAt.toISOString(), id: entry.id })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeLedgerCursor(cursor: string, secret: string): LedgerCursor {
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidLedgerCursorError("malformed cursor");
  }
  const [payload, signature] = parts;
  const expectedSignature = sign(payload, secret);
  const provided = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  // RN: comparar tamanho antes de timingSafeEqual - buffers de tamanhos diferentes fariam a
  // própria chamada lançar, em vez de ser tratada como "assinatura não corresponde".
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new InvalidLedgerCursorError("signature does not match");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidLedgerCursorError("payload is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== "string" ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new InvalidLedgerCursorError("payload shape is invalid");
  }
  const createdAt = new Date((parsed as { createdAt: string }).createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidLedgerCursorError("payload createdAt is not a valid date");
  }
  return { createdAt, id: (parsed as { id: string }).id };
}
