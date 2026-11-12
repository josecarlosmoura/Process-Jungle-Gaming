import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

const env = validateEnv(process.env);
const orm = await MikroORM.init({
  ...buildMikroOrmOptions({
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    dbName: env.DB_NAME,
  }),
  connect: true,
});

async function pgcryptoExists(): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute<{ exists: boolean }[]>(
      "select exists(select 1 from pg_extension where extname = 'pgcrypto') as exists",
    );
  return rows[0]?.exists === true;
}

async function migrationRowExists(): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute<{ exists: boolean }[]>(
      "select exists(select 1 from mikro_orm_migrations where name like '%Initial%') as exists",
    );
  return rows[0]?.exists === true;
}

afterAll(async () => {
  await orm.close();
});

describe("migration:up / migration:down", () => {
  test("migration:up creates the pgcrypto extension and records it in mikro_orm_migrations", async () => {
    // garante a precondicao "down" por si mesmo, em vez de depender da ordem de execucao
    // dos testes deste arquivo (achado do Verifier: um proof isolado nao pode herdar estado)
    execSync("bun run migration:down", { cwd: process.cwd(), stdio: "pipe" });
    await expect(pgcryptoExists()).resolves.toBe(false);

    execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });

    await expect(pgcryptoExists()).resolves.toBe(true);
    await expect(migrationRowExists()).resolves.toBe(true);
  });

  test("migration:down drops the pgcrypto extension and removes its row from mikro_orm_migrations", async () => {
    // garante a precondicao "up" por si mesmo - sem isto, rodar este teste isolado contra um
    // banco ja revertido faria o proof passar mesmo que down() fosse um no-op (achado do Verifier)
    execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
    await expect(pgcryptoExists()).resolves.toBe(true);

    execSync("bun run migration:down", { cwd: process.cwd(), stdio: "pipe" });

    await expect(pgcryptoExists()).resolves.toBe(false);
    await expect(migrationRowExists()).resolves.toBe(false);
  });
});
