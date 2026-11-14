import { describe, expect, test } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { parseLedgerLimit } from "./wallets.controller";

describe("parseLedgerLimit", () => {
  test("returns 50 when limit is omitted", () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
  });

  test("clamps a limit above 200 down to 200", () => {
    expect(parseLedgerLimit("500")).toBe(200);
    expect(parseLedgerLimit("201")).toBe(200);
  });

  test("keeps a limit within [1, 200] unchanged", () => {
    expect(parseLedgerLimit("1")).toBe(1);
    expect(parseLedgerLimit("2")).toBe(2);
    expect(parseLedgerLimit("200")).toBe(200);
  });

  test("throws BadRequestException for a limit below 1 or not an integer", () => {
    for (const invalid of ["0", "-1", "1.5", "abc", "", "1e3"]) {
      expect(() => parseLedgerLimit(invalid)).toThrow(BadRequestException);
    }
  });
});
