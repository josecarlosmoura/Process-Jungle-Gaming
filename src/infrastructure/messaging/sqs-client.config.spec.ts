import { describe, expect, test } from "bun:test";
import { buildSqsClientConfig } from "./sqs-client.config";

describe("buildSqsClientConfig", () => {
  test("buildSqsClientConfig maps the given endpoint, region and credentials verbatim, not a hardcoded value", () => {
    const config = buildSqsClientConfig({
      localstackEndpoint: "http://example-endpoint:4566",
      awsRegion: "sa-east-1",
      awsAccessKeyId: "given-access-key-id",
      awsSecretAccessKey: "given-secret-access-key",
    });

    expect(config.endpoint).toBe("http://example-endpoint:4566");
    expect(config.region).toBe("sa-east-1");
    expect(config.credentials).toEqual({
      accessKeyId: "given-access-key-id",
      secretAccessKey: "given-secret-access-key",
    });
  });
});
