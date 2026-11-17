import { describe, expect, test } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { NoopAuthGuard } from "./noop-auth.guard";

function fakeContext(): ExecutionContext {
  return {} as unknown as ExecutionContext;
}

describe("NoopAuthGuard", () => {
  test("always allows the request, regardless of the execution context", () => {
    const guard = new NoopAuthGuard();

    expect(guard.canActivate(fakeContext())).toBe(true);
  });
});
