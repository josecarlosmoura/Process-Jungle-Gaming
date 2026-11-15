import { beforeEach, describe, expect, test } from "bun:test";
import { MetricsService } from "./metrics.service";

const METRIC_NAMES = [
  "wager_transactions_total",
  "wager_transaction_duration_seconds",
  "idempotency_duplicates_total",
  "retries_total",
  "dlq_messages_total",
  "lock_wait_timeout_total",
  "outbox_lag_seconds",
];

function labelSetOf(text: string, name: string): Set<string> | undefined {
  for (const line of text.split("\n")) {
    const match = line.match(new RegExp(`^${name}\\{(.*)\\}\\s`));
    if (match) {
      return new Set(match[1].split(",").map((pair) => pair.split("=")[0] as string));
    }
  }
  return undefined;
}

beforeEach(() => {
  MetricsService.resetForTesting();
});

describe("MetricsService", () => {
  test("exposes # HELP and # TYPE for every documented metric name", async () => {
    const text = await MetricsService.getMetricsText();

    for (const name of METRIC_NAMES) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  test("wager_transactions_total only ever carries the status and kind labels", async () => {
    MetricsService.recordTransactionOutcome("PROCESSED", "BET");

    const labels = labelSetOf(await MetricsService.getMetricsText(), "wager_transactions_total");

    expect(labels).toEqual(new Set(["status", "kind"]));
  });

  test("idempotency_duplicates_total only ever carries the channel label", async () => {
    MetricsService.recordDuplicate("http");

    const labels = labelSetOf(await MetricsService.getMetricsText(), "idempotency_duplicates_total");

    expect(labels).toEqual(new Set(["channel"]));
  });

  test("recordTransactionOutcome increments only the exact status+kind combination observed", async () => {
    MetricsService.recordTransactionOutcome("PROCESSED", "BET");
    MetricsService.recordTransactionOutcome("PROCESSED", "BET");
    MetricsService.recordTransactionOutcome("REJECTED", "BET");

    const text = await MetricsService.getMetricsText();

    expect(text).toContain('wager_transactions_total{status="PROCESSED",kind="BET"} 2');
    expect(text).toContain('wager_transactions_total{status="REJECTED",kind="BET"} 1');
  });

  test("observeTransactionDuration records an observation reflected in the histogram's count", async () => {
    MetricsService.observeTransactionDuration(0.05);

    const text = await MetricsService.getMetricsText();

    expect(text).toContain("wager_transaction_duration_seconds_count 1");
  });

  test("recordDuplicate increments the given channel independently of the other", async () => {
    MetricsService.recordDuplicate("http");
    MetricsService.recordDuplicate("http");
    MetricsService.recordDuplicate("inbox_sqs");

    const text = await MetricsService.getMetricsText();

    expect(text).toContain('idempotency_duplicates_total{channel="http"} 2');
    expect(text).toContain('idempotency_duplicates_total{channel="inbox_sqs"} 1');
  });

  test("recordRetry increments retries_total", async () => {
    MetricsService.recordRetry();
    MetricsService.recordRetry();

    const text = await MetricsService.getMetricsText();

    expect(text).toContain("retries_total 2");
  });

  test("recordLockWaitTimeout increments lock_wait_timeout_total", async () => {
    MetricsService.recordLockWaitTimeout();

    const text = await MetricsService.getMetricsText();

    expect(text).toContain("lock_wait_timeout_total 1");
  });

  test("recordDlqMessages only increments for a strictly positive delta, never for zero or negative", async () => {
    MetricsService.recordDlqMessages(3);
    MetricsService.recordDlqMessages(0);
    MetricsService.recordDlqMessages(-2);

    const text = await MetricsService.getMetricsText();

    expect(text).toContain("dlq_messages_total 3");
  });

  test("setOutboxLag sets the gauge to the given value, including 0", async () => {
    MetricsService.setOutboxLag(42.5);
    expect(await MetricsService.getMetricsText()).toContain("outbox_lag_seconds 42.5");

    MetricsService.setOutboxLag(0);
    expect(await MetricsService.getMetricsText()).toContain("outbox_lag_seconds 0");
  });
});
