import { describe, expect, test } from "bun:test";
import { buildMikroOrmOptions, resolveCliMikroOrmOptions } from "./mikro-orm.config";

describe("buildMikroOrmOptions", () => {
  test("buildMikroOrmOptions maps the given dbHost, dbPort, dbUser, dbPassword and dbName verbatim, not a hardcoded value", () => {
    const options = buildMikroOrmOptions({
      dbHost: "some-custom-host",
      dbPort: 54321,
      dbUser: "some-custom-user",
      dbPassword: "some-custom-password",
      dbName: "some_custom_db",
    });

    expect(options.host).toBe("some-custom-host");
    expect(options.port).toBe(54321);
    expect(options.user).toBe("some-custom-user");
    expect(options.password).toBe("some-custom-password");
    expect(options.dbName).toBe("some_custom_db");
  });
});

describe("resolveCliMikroOrmOptions", () => {
  test("resolveCliMikroOrmOptions derives its options from the given env via validateEnv, not a hardcoded value", () => {
    const env = {
      DB_HOST: "cli-custom-host",
      DB_PORT: "6543",
      DB_USER: "cli-custom-user",
      DB_PASSWORD: "cli-custom-password",
      DB_NAME: "cli_custom_db",
      LOCALSTACK_ENDPOINT: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      LEDGER_CURSOR_SECRET: "cli-custom-ledger-cursor-secret",
    };

    const options = resolveCliMikroOrmOptions(env);

    expect(options.host).toBe("cli-custom-host");
    expect(options.port).toBe(6543);
    expect(options.user).toBe("cli-custom-user");
    expect(options.password).toBe("cli-custom-password");
    expect(options.dbName).toBe("cli_custom_db");
  });

  test("resolveCliMikroOrmOptions rejects a missing or malformed variable, naming it in the error", () => {
    const env = { DB_HOST: "cli-custom-host" };

    expect(() => resolveCliMikroOrmOptions(env)).toThrow("DB_PORT");
  });
});
