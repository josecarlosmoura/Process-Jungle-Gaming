import { describe, expect, test } from "bun:test";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "./wager-transaction.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "./wallet-ledger-entry.repository";
import { WALLET_REPOSITORY_INTERFACE } from "./wallet.repository";

describe("repository injection tokens", () => {
  test("each repository port exports its own distinct Symbol token", () => {
    const tokens = [
      WALLET_REPOSITORY_INTERFACE,
      WAGER_TRANSACTION_REPOSITORY_INTERFACE,
      WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE,
    ];

    for (const token of tokens) {
      expect(typeof token).toBe("symbol");
    }

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
