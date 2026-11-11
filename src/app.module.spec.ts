import { describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module";

describe("AppModule", () => {
  test("compiles with no providers or controllers", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
