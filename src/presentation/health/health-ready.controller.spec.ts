import { describe, expect, test } from "bun:test";
import { ServiceUnavailableException } from "@nestjs/common";
import type { PostgresHealthIndicator } from "../../infrastructure/database/postgres-health.indicator";
import type { SqsHealthIndicator } from "../../infrastructure/messaging/sqs-health.indicator";
import { HealthReadyController } from "./health-ready.controller";

function withIndicatorResult(up: boolean): PostgresHealthIndicator {
  return { check: () => Promise.resolve(up) } as unknown as PostgresHealthIndicator;
}

function withSqsIndicatorResult(up: boolean): SqsHealthIndicator {
  return { check: () => Promise.resolve(up) } as unknown as SqsHealthIndicator;
}

describe("HealthReadyController", () => {
  test("responds 200 with status ok postgres up and sqs up when both indicators report up", async () => {
    const controller = new HealthReadyController(withIndicatorResult(true), withSqsIndicatorResult(true));

    const result = await controller.ready();

    expect(result).toEqual({ status: "ok", postgres: "up", sqs: "up" });
  });

  test("responds 503 with status error postgres down and sqs up when only postgres reports down", async () => {
    const controller = new HealthReadyController(withIndicatorResult(false), withSqsIndicatorResult(true));

    const rejection = controller.ready();

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await rejection.catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({ status: "error", postgres: "down", sqs: "up" });
    });
  });

  test("responds 503 with status error postgres up and sqs down when only sqs reports down", async () => {
    const controller = new HealthReadyController(withIndicatorResult(true), withSqsIndicatorResult(false));

    const rejection = controller.ready();

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await rejection.catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({ status: "error", postgres: "up", sqs: "down" });
    });
  });

  test("responds 503 with status error postgres down and sqs down when both indicators report down", async () => {
    const controller = new HealthReadyController(withIndicatorResult(false), withSqsIndicatorResult(false));

    const rejection = controller.ready();

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await rejection.catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({ status: "error", postgres: "down", sqs: "down" });
    });
  });
});
