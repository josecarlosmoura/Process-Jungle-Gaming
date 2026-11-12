import { describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { HealthModule } from "./health.module";

describe("GET /health/live", () => {
  test("returns 200 with status ok over real HTTP", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/health/live`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });

    await app.close();
  });
});
