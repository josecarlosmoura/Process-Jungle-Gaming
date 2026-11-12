import { describe, expect, test } from "bun:test";
import { ServiceUnavailableException } from "@nestjs/common";
import type { PostgresHealthIndicator } from "../../infrastructure/database/postgres-health.indicator";
import { HealthReadyController } from "./health-ready.controller";

function withIndicatorResult(up: boolean): PostgresHealthIndicator {
  return { check: () => Promise.resolve(up) } as unknown as PostgresHealthIndicator;
}

describe("HealthReadyController", () => {
  test("responds 200 with status ok and postgres up when the indicator reports up", async () => {
    const controller = new HealthReadyController(withIndicatorResult(true));

    const result = await controller.ready();

    expect(result).toEqual({ status: "ok", postgres: "up" });
  });

  test("responds 503 with status error and postgres down when the indicator reports down", async () => {
    const controller = new HealthReadyController(withIndicatorResult(false));

    const rejection = controller.ready();

    await expect(rejection).rejects.toBeInstanceOf(ServiceUnavailableException);
    await rejection.catch((error: ServiceUnavailableException) => {
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({ status: "error", postgres: "down" });
    });
  });
});
