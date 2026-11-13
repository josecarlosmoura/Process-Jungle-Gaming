import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  InvalidLedgerCursorError,
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "./wallet-ledger-entry.repository";

const secret = "test-secret";
const entry = { createdAt: new Date("2026-11-12T10:05:00.000Z"), id: randomUUID() };

describe("encodeLedgerCursor / decodeLedgerCursor", () => {
  test("decodeLedgerCursor reverses encodeLedgerCursor exactly for createdAt and id", () => {
    const cursor = encodeLedgerCursor(entry, secret);
    const decoded = decodeLedgerCursor(cursor, secret);

    expect(decoded.createdAt.toISOString()).toBe(entry.createdAt.toISOString());
    expect(decoded.id).toBe(entry.id);
  });

  test("decodeLedgerCursor throws InvalidLedgerCursorError when the payload is tampered", () => {
    const cursor = encodeLedgerCursor(entry, secret);
    const [payload, signature] = cursor.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ createdAt: entry.createdAt.toISOString(), id: randomUUID() }),
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${signature}`;

    expect(() => decodeLedgerCursor(tampered, secret)).toThrow(InvalidLedgerCursorError);
    expect(payload).not.toBe(tamperedPayload);
  });

  test("decodeLedgerCursor throws InvalidLedgerCursorError when signed with a different secret", () => {
    const cursor = encodeLedgerCursor(entry, secret);

    expect(() => decodeLedgerCursor(cursor, "a-different-secret")).toThrow(InvalidLedgerCursorError);
  });
});
