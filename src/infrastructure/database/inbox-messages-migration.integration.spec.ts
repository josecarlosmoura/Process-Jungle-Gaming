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

interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await connection.execute<{ exists: boolean }[]>(
    "select exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = ?) as exists",
    [table],
  );
  return rows[0]?.exists === true;
}

async function ensureInboxMessagesTableExists(): Promise<void> {
  // Garante a pre-condicao sem depender da ordem de execucao entre os describes deste
  // arquivo (mesmo cuidado documentado em wallets-migration.integration.spec.ts) - mas so
  // paga o custo de subir um processo novo quando a tabela de fato nao existe.
  if (await tableExists("inbox_messages")) {
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

async function inboxMessagesColumns(): Promise<ColumnInfo[]> {
  return connection.execute<ColumnInfo[]>(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = 'inbox_messages'`,
  );
}

async function inboxMessagesConstraints(): Promise<ConstraintInfo[]> {
  return connection.execute<ConstraintInfo[]>(
    `select constraint_name, constraint_type
     from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'inbox_messages'`,
  );
}

async function primaryKeyColumns(): Promise<string[]> {
  const rows = await connection.execute<{ column_name: string }[]>(
    `select kcu.column_name
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
     where tc.table_schema = 'public' and tc.table_name = 'inbox_messages' and tc.constraint_type = 'PRIMARY KEY'
     order by kcu.ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}

function insertInboxMessage(params: {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}): Promise<unknown> {
  return connection.execute(
    `insert into inbox_messages (consumer_name, message_id, payload_hash)
     values (?, ?, ?)`,
    [params.consumerName, params.messageId, params.payloadHash],
  );
}

async function deleteInboxMessage(consumerName: string, messageId: string): Promise<void> {
  await connection.execute("delete from inbox_messages where consumer_name = ? and message_id = ?", [
    consumerName,
    messageId,
  ]);
}

afterAll(async () => {
  await orm.close();
});

describe("inbox_messages table schema (migration:up)", () => {
  test("migration:up creates the inbox_messages table with exactly the consumer_name, message_id, payload_hash, received_at and processed_at columns", async () => {
    await ensureInboxMessagesTableExists();

    const columns = await inboxMessagesColumns();
    const columnNames = columns.map((c) => c.column_name).sort();

    expect(columnNames).toEqual(
      ["consumer_name", "message_id", "payload_hash", "received_at", "processed_at"].sort(),
    );

    const consumerName = columns.find((c) => c.column_name === "consumer_name");
    const messageId = columns.find((c) => c.column_name === "message_id");
    const payloadHash = columns.find((c) => c.column_name === "payload_hash");
    expect(consumerName?.data_type).toBe("text");
    expect(messageId?.data_type).toBe("text");
    expect(payloadHash?.data_type).toBe("text");
  });

  test("the primary key is the composite (consumer_name, message_id), in that order", async () => {
    await ensureInboxMessagesTableExists();

    expect(await primaryKeyColumns()).toEqual(["consumer_name", "message_id"]);
  });

  test("received_at is a timestamptz, not nullable, defaulting to now()", async () => {
    await ensureInboxMessagesTableExists();

    const columns = await inboxMessagesColumns();
    const receivedAt = columns.find((c) => c.column_name === "received_at");

    expect(receivedAt?.data_type).toBe("timestamp with time zone");
    expect(receivedAt?.is_nullable).toBe("NO");
    expect(receivedAt?.column_default).toContain("now()");
  });

  test("processed_at is a nullable timestamptz with no default", async () => {
    await ensureInboxMessagesTableExists();

    const columns = await inboxMessagesColumns();
    const processedAt = columns.find((c) => c.column_name === "processed_at");

    expect(processedAt?.data_type).toBe("timestamp with time zone");
    expect(processedAt?.is_nullable).toBe("YES");
    expect(processedAt?.column_default).toBeNull();
  });
});

describe("inbox_messages table reversibility (migration:down)", () => {
  test(
    "migration:down drops the inbox_messages table and removes its row from mikro_orm_migrations",
    async () => {
      await ensureInboxMessagesTableExists();
      await expect(tableExists("inbox_messages")).resolves.toBe(true);

      // "--to <nome>" reverte esta migration e qualquer uma mais nova empilhada depois dela
      // (hoje, CreateOutboxMessages) - mesmo padrao documentado em
      // wager-transactions-reversal-reference-indexes-migration.integration.spec.ts. A unica
      // asserção deste teste e sobre inbox_messages, que nao compartilha nenhuma coluna/constraint
      // com outbox_messages, entao o efeito colateral de reverter/recriar a outra tabela nao
      // interfere na comparacao.
      execSync(
        "bun run migration:down -- --to Migration20261113170000_CreateInboxMessages",
        { cwd: process.cwd(), stdio: "pipe" },
      );

      await expect(tableExists("inbox_messages")).resolves.toBe(false);
      await expect(migrationRowExists("%CreateInboxMessages%")).resolves.toBe(false);

      // restaura a tabela (e a outbox, revertida em cascata) - outros testes deste arquivo e do
      // arquivo de outbox assumem que ela existe, independentemente da ordem de execucao
      execSync("bun run migration:up", { cwd: process.cwd(), stdio: "pipe" });
    },
    // duas chamadas reais de CLI (cold start de ts-node + bun + reconexao) rotineiramente passam
    // dos 5000ms padrao - nao e travamento (ver migrations.integration.spec.ts).
    20_000,
  );
});

describe("inbox_messages constraints enforced by Postgres", () => {
  test("a second insert with the same (consumer_name, message_id) violates the primary key constraint", async () => {
    await ensureInboxMessagesTableExists();
    const consumerName = `consumer-${randomUUID()}`;
    const messageId = `message-${randomUUID()}`;

    try {
      await insertInboxMessage({ consumerName, messageId, payloadHash: randomUUID() });

      const duplicateInsert = insertInboxMessage({
        consumerName,
        messageId,
        payloadHash: randomUUID(),
      });

      await expect(duplicateInsert).rejects.toMatchObject({ code: "23505" });
    } finally {
      await deleteInboxMessage(consumerName, messageId);
    }
  });

  test("a second insert with the same message_id but a different consumer_name succeeds", async () => {
    await ensureInboxMessagesTableExists();
    const messageId = `message-${randomUUID()}`;
    const firstConsumer = `consumer-${randomUUID()}`;
    const secondConsumer = `consumer-${randomUUID()}`;

    try {
      await insertInboxMessage({ consumerName: firstConsumer, messageId, payloadHash: randomUUID() });
      await insertInboxMessage({ consumerName: secondConsumer, messageId, payloadHash: randomUUID() });

      const rows = await connection.execute<{ count: string }[]>(
        "select count(*) as count from inbox_messages where message_id = ?",
        [messageId],
      );
      expect(Number(rows[0]?.count)).toBe(2);
    } finally {
      await deleteInboxMessage(firstConsumer, messageId);
      await deleteInboxMessage(secondConsumer, messageId);
    }
  });
});
