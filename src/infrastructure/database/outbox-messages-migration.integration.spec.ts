import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "./mikro-orm.config";

// Forca wagering_test independente de como o teste e invocado - rodando via Test Explorer da
// IDE (sem o script "test" do package.json, cujo "DB_NAME=wagering_test bun test" normalmente
// define essa env var), o .env traria "wagering_dev", e este arquivo roda migration:down --to
// via execSync, que apagaria as tabelas do banco de desenvolvimento.
Object.assign(process.env, { DB_NAME: "wagering_test" });

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
const connection = orm.em.getConnection();

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = ?) as exists",
    [table],
  );
  return rows[0]?.exists === true;
}

async function ensureOutboxMessagesTableExists(): Promise<void> {
  if (await tableExists("outbox_messages")) {
    return;
  }
  execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
}

async function migrationRowExists(namePattern: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from mikro_orm_migrations where name like ?) as exists",
    [namePattern],
  );
  return rows[0]?.exists === true;
}

async function outboxMessagesColumns(): Promise<ColumnInfo[]> {
  return connection.execute<ColumnInfo[]>(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'outbox_messages'`,
  );
}

async function indexDefinition(indexName: string): Promise<string | undefined> {
  const rows = await connection.execute<{ index_definition: string }[]>(
    `select pg_get_indexdef(ix.indexrelid) as index_definition
     from pg_class t
     join pg_index ix on t.oid = ix.indrelid
     join pg_class i on i.oid = ix.indexrelid
     where t.relname = 'outbox_messages' and i.relname = ?`,
    [indexName],
  );
  return rows[0]?.index_definition;
}

function insertOutboxMessage(params: {
  id: string;
  aggregateId: string;
  eventType?: string;
  attempts?: number;
}): Promise<unknown> {
  if (params.attempts === undefined) {
    return connection.execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       values (?, ?, ?, ?, now())`,
      [params.id, params.aggregateId, params.eventType ?? "WagerTransactionProcessed", JSON.stringify({ a: 1 })],
    );
  }
  return connection.execute(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
     values (?, ?, ?, ?, now(), ?)`,
    [
      params.id,
      params.aggregateId,
      params.eventType ?? "WagerTransactionProcessed",
      JSON.stringify({ a: 1 }),
      params.attempts,
    ],
  );
}

async function deleteOutboxMessage(id: string): Promise<void> {
  await connection.execute("delete from outbox_messages where id = ?", [id]);
}

afterAll(async () => {
  await orm.close();
});

describe("outbox_messages table schema (migration:up)", () => {
  test("migration:up creates the outbox_messages table with exactly the id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at and published_at columns", async () => {
    await ensureOutboxMessagesTableExists();

    const columns = await outboxMessagesColumns();
    const columnNames = columns.map((c) => c.column_name).sort();

    expect(columnNames).toEqual(
      ["id", "aggregate_id", "event_type", "payload", "occurred_at", "attempts", "next_attempt_at", "published_at"].sort(),
    );

    const id = columns.find((c) => c.column_name === "id");
    const aggregateId = columns.find((c) => c.column_name === "aggregate_id");
    const eventType = columns.find((c) => c.column_name === "event_type");
    const occurredAt = columns.find((c) => c.column_name === "occurred_at");
    expect(id?.data_type).toBe("uuid");
    expect(id?.is_nullable).toBe("NO");
    expect(aggregateId?.data_type).toBe("uuid");
    expect(aggregateId?.is_nullable).toBe("NO");
    expect(eventType?.data_type).toBe("text");
    expect(eventType?.is_nullable).toBe("NO");
    expect(occurredAt?.data_type).toBe("timestamp with time zone");
    expect(occurredAt?.is_nullable).toBe("NO");
    expect(occurredAt?.column_default).toBeNull();
  });

  test("the payload column is jsonb and not nullable", async () => {
    await ensureOutboxMessagesTableExists();

    const columns = await outboxMessagesColumns();
    const payload = columns.find((c) => c.column_name === "payload");

    expect(payload?.data_type).toBe("jsonb");
    expect(payload?.is_nullable).toBe("NO");
  });

  test("attempts is an integer, not nullable, defaulting to 0", async () => {
    await ensureOutboxMessagesTableExists();

    const columns = await outboxMessagesColumns();
    const attempts = columns.find((c) => c.column_name === "attempts");

    expect(attempts?.data_type).toBe("integer");
    expect(attempts?.is_nullable).toBe("NO");
    expect(attempts?.column_default).toBe("0");
  });

  test("next_attempt_at and published_at are nullable timestamptz columns with no default", async () => {
    await ensureOutboxMessagesTableExists();

    const columns = await outboxMessagesColumns();
    const nextAttemptAt = columns.find((c) => c.column_name === "next_attempt_at");
    const publishedAt = columns.find((c) => c.column_name === "published_at");

    expect(nextAttemptAt?.data_type).toBe("timestamp with time zone");
    expect(nextAttemptAt?.is_nullable).toBe("YES");
    expect(nextAttemptAt?.column_default).toBeNull();
    expect(publishedAt?.data_type).toBe("timestamp with time zone");
    expect(publishedAt?.is_nullable).toBe("YES");
    expect(publishedAt?.column_default).toBeNull();
  });

  test("the published_at/next_attempt_at polling index exists over exactly those two columns, in that order", async () => {
    await ensureOutboxMessagesTableExists();

    const definition = await indexDefinition("outbox_messages_published_next_attempt_idx");

    expect(definition).toContain("(published_at, next_attempt_at)");
  });
});

describe("outbox_messages table reversibility (migration:down)", () => {
  test(
    "migration:down drops the outbox_messages table and its polling index, and removes its row from mikro_orm_migrations",
    async () => {
      await ensureOutboxMessagesTableExists();
      await expect(tableExists("outbox_messages")).resolves.toBe(true);

      // CreateOutboxMessages e, hoje, a migration mais nova do projeto - "--to" aqui reverte
      // so ela mesma, sem cascata sobre nenhuma outra.
      execSync(
        "bun run migration:down -- --to Migration20261113180000_CreateOutboxMessages",
        { cwd: process.cwd(), stdio: "pipe" },
      );

      await expect(tableExists("outbox_messages")).resolves.toBe(false);
      await expect(migrationRowExists("%CreateOutboxMessages%")).resolves.toBe(false);

      const indexRows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'outbox_messages_published_next_attempt_idx') as exists",
      );
      expect(indexRows[0]?.exists).toBe(false);

      // restaura a tabela - outros testes deste arquivo assumem que ela existe,
      // independentemente da ordem de execucao
      execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
    },
    20_000,
  );
});

describe("outbox_messages constraints enforced by Postgres", () => {
  test("an insert with a negative attempts value violates the check constraint", async () => {
    await ensureOutboxMessagesTableExists();
    const id = randomUUID();

    const invalidInsert = insertOutboxMessage({ id, aggregateId: randomUUID(), attempts: -1 });

    await expect(invalidInsert).rejects.toMatchObject({ code: "23514" });
  });

  test("an insert with attempts explicitly 0 succeeds - the boundary the check allows", async () => {
    await ensureOutboxMessagesTableExists();
    const id = randomUUID();

    try {
      await insertOutboxMessage({ id, aggregateId: randomUUID(), attempts: 0 });

      const rows = await connection.execute<{ exists: boolean }[]>(
        "select exists(select 1 from outbox_messages where id = ?) as exists",
        [id],
      );
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await deleteOutboxMessage(id);
    }
  });

  test("an insert with attempts omitted relies on the column default of 0", async () => {
    await ensureOutboxMessagesTableExists();
    const id = randomUUID();

    try {
      await insertOutboxMessage({ id, aggregateId: randomUUID() });

      const rows = await connection.execute<{ attempts: number }[]>(
        "select attempts from outbox_messages where id = ?",
        [id],
      );
      expect(rows[0]?.attempts).toBe(0);
    } finally {
      await deleteOutboxMessage(id);
    }
  });
});
