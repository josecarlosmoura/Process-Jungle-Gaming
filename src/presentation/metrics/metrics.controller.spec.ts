import { beforeEach, describe, expect, test } from "bun:test";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { MetricsController } from "./metrics.controller";

function fakeResponse(): { headers: Record<string, string>; body?: string; set: (key: string, value: string) => void; send: (body: string) => void } {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  return {
    headers,
    get body() {
      return body;
    },
    set: (key: string, value: string) => {
      headers[key] = value;
    },
    send: (b: string) => {
      body = b;
    },
  };
}

beforeEach(() => {
  MetricsService.resetForTesting();
});

describe("MetricsController", () => {
  test("responds with the Prometheus content type and a body containing # HELP/# TYPE lines", async () => {
    MetricsService.recordTransactionOutcome("PROCESSED", "BET");
    const controller = new MetricsController();
    const res = fakeResponse();

    await controller.get(res as never);

    expect(res.headers["Content-Type"]).toContain("text/plain");
    expect(res.headers["Content-Type"]).toContain("version=0.0.4");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toContain("# HELP wager_transactions_total ");
    expect(res.body).toContain("# TYPE wager_transactions_total counter");
    expect(res.body).toContain('wager_transactions_total{status="PROCESSED",kind="BET"} 1');
  });
});
