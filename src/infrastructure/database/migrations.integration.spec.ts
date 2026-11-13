import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

// Banco proprio (wagering_test_migrations), separado do wagering_test usado pelos demais specs
// de integracao/e2e - este arquivo roda migration:down --to 0 (derruba todas as tabelas) e depois
// migration:up, duas vezes. O bun test executa arquivos concorrentemente por padrao (--isolate so
// isola o registro de modulos por arquivo, nao serializa execucao nem isola o banco); contra um
// banco compartilhado, a janela em que o schema fica vazio colide com qualquer outro teste que
// esteja consultando "wallets" etc. no mesmo instante, causando falhas intermitentes do tipo
// "relation does not exist" nesses outros arquivos.
Object.assign(process.env, { DB_NAME: "wagering_test_migrations" });

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
  test(
    "migration:up creates the pgcrypto extension and records it in mikro_orm_migrations",
    async () => {
      // garante a precondicao "down" por si mesmo, em vez de depender da ordem de execucao
      // dos testes deste arquivo (achado do Verifier: um proof isolado nao pode herdar estado).
      // "--to 0" reverte TODAS as migrations, nao so a mais recente - a partir da implementação
      // da migration de wallets existe mais de uma migration no projeto, e "migration:down" sem
      // argumento desfaz só um passo.
      execSync("bun run migration:down -- --to 0", { cwd: process.cwd(), stdio: "pipe" });
      await expect(pgcryptoExists()).resolves.toBe(false);

      execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });

      await expect(pgcryptoExists()).resolves.toBe(true);
      await expect(migrationRowExists()).resolves.toBe(true);
    },
    // cada execSync sobe um processo novo (ts-node + bun + reconexao no Postgres) - duas
    // chamadas neste teste rotineiramente passam dos 5000ms padrao do bun test, sem que
    // nada esteja travado (confirmado: o mesmo comando roda em ~1.5s isolado fora de um
    // teste; o custo extra aqui e o cold start do processo filho).
    20_000,
  );

  test(
    "migration:down drops the pgcrypto extension and removes its row from mikro_orm_migrations",
    async () => {
      // garante a precondicao "up" por si mesmo - sem isto, rodar este teste isolado contra um
      // banco ja revertido faria o proof passar mesmo que down() fosse um no-op (achado do Verifier)
      execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
      await expect(pgcryptoExists()).resolves.toBe(true);

      execSync("bun run migration:down -- --to 0", { cwd: process.cwd(), stdio: "pipe" });

      await expect(pgcryptoExists()).resolves.toBe(false);
      await expect(migrationRowExists()).resolves.toBe(false);
    },
    20_000,
  );
});
