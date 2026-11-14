import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";
import { buildMikroOrmOptions } from "../database/mikro-orm.config";
import { OutboxMessageMikroOrmRepository } from "./outbox-message.repository";

// Forca wagering_test independente de como o teste e invocado - nunca toca o banco de
// desenvolvimento (.env usa wagering_dev), mesmo padrao de wallet.repository.integration.spec.ts.
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

afterAll(async () => {
  await orm.close();
});

interface RawRow {
  id: string;
  aggregateId: string;
  occurredAt: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

async function insertRaw(row: RawRow): Promise<void> {
  await connection.execute(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
     values (?, ?, 'TestEvent', '{}'::jsonb, ?, ?, ?, ?)`,
    [
      row.id,
      row.aggregateId,
      row.occurredAt,
      row.attempts ?? 0,
      row.nextAttemptAt ?? null,
      row.publishedAt ?? null,
    ],
  );
}

async function deleteRows(ids: string[]): Promise<void> {
  for (const id of ids) {
    await connection.execute("delete from outbox_messages where id = ?", [id]);
  }
}

describe("OutboxMessageMikroOrmRepository.claimPendingBatch", () => {
  test("claimPendingBatch returns due messages ordered by occurredAt, up to the given limit", async () => {
    const idOld = randomUUID();
    const idMiddle = randomUUID();
    const idNew = randomUUID();
    const aggregateId = randomUUID();
    try {
      await insertRaw({ id: idNew, aggregateId, occurredAt: new Date("2026-03-01T10:00:02.000Z") });
      await insertRaw({ id: idOld, aggregateId, occurredAt: new Date("2026-03-01T10:00:00.000Z") });
      await insertRaw({ id: idMiddle, aggregateId, occurredAt: new Date("2026-03-01T10:00:01.000Z") });

      const claimed = await orm.em
        .fork()
        .transactional((em) => new OutboxMessageMikroOrmRepository(em).claimPendingBatch(new Date(), 2));

      expect(claimed.map((m) => m.id)).toEqual([idOld, idMiddle]);
    } finally {
      await deleteRows([idOld, idMiddle, idNew]);
    }
  });

  test("claimPendingBatch excludes a message whose nextAttemptAt is still in the future", async () => {
    const dueId = randomUUID();
    const futureId = randomUUID();
    const aggregateId = randomUUID();
    const now = new Date("2026-03-01T10:00:00.000Z");
    try {
      await insertRaw({ id: dueId, aggregateId, occurredAt: now, nextAttemptAt: new Date(now.getTime() - 1_000) });
      await insertRaw({ id: futureId, aggregateId, occurredAt: now, nextAttemptAt: new Date(now.getTime() + 60_000) });

      const claimed = await orm.em
        .fork()
        .transactional((em) => new OutboxMessageMikroOrmRepository(em).claimPendingBatch(now, 10));

      expect(claimed.map((m) => m.id)).toContain(dueId);
      expect(claimed.map((m) => m.id)).not.toContain(futureId);
    } finally {
      await deleteRows([dueId, futureId]);
    }
  });

  test("claimPendingBatch excludes a message that already has publishedAt set", async () => {
    const pendingId = randomUUID();
    const publishedId = randomUUID();
    const aggregateId = randomUUID();
    const now = new Date("2026-03-01T10:00:00.000Z");
    try {
      await insertRaw({ id: pendingId, aggregateId, occurredAt: now });
      await insertRaw({ id: publishedId, aggregateId, occurredAt: now, publishedAt: now });

      const claimed = await orm.em
        .fork()
        .transactional((em) => new OutboxMessageMikroOrmRepository(em).claimPendingBatch(now, 10));

      expect(claimed.map((m) => m.id)).toContain(pendingId);
      expect(claimed.map((m) => m.id)).not.toContain(publishedId);
    } finally {
      await deleteRows([pendingId, publishedId]);
    }
  });

  test(
    "two concurrent claimPendingBatch calls over the same pending rows return disjoint sets",
    async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      const aggregateId = randomUUID();
      const now = new Date();
      try {
        await insertRaw({ id: idA, aggregateId, occurredAt: now });
        await insertRaw({ id: idB, aggregateId, occurredAt: now });

        let firstClaimed: string[] = [];
        let secondClaimed: string[] = [];
        let secondResolvedAfterMs: number | null = null;
        const start = Date.now();
        // Sinaliza o claim concluido (lock ja mantido pela transacao) em vez de um sleep fixo -
        // o lock do SELECT FOR UPDATE existe desde que a instrucao retorna, bem antes do commit,
        // entao esperar esse sinal (nunca um tempo de parede) elimina a corrida contra a segunda
        // transacao.
        let resolveFirstClaimed: () => void;
        const firstClaimedPromise = new Promise<void>((resolve) => {
          resolveFirstClaimed = resolve;
        });

        const firstTx = orm.em.fork().transactional(async (em) => {
          const claimed = await new OutboxMessageMikroOrmRepository(em).claimPendingBatch(now, 1);
          firstClaimed = claimed.map((m) => m.id);
          resolveFirstClaimed();
          await new Promise((resolve) => setTimeout(resolve, 400));
        });

        await firstClaimedPromise;

        const secondTx = orm.em.fork().transactional(async (em) => {
          const claimed = await new OutboxMessageMikroOrmRepository(em).claimPendingBatch(now, 2);
          secondClaimed = claimed.map((m) => m.id);
          secondResolvedAfterMs = Date.now() - start;
        });

        await Promise.all([firstTx, secondTx]);

        expect(firstClaimed.length).toBe(1);
        expect(secondClaimed.length).toBe(1);
        expect(secondClaimed).not.toEqual(firstClaimed);
        expect(new Set([...firstClaimed, ...secondClaimed])).toEqual(new Set([idA, idB]));
        // SKIP LOCKED nunca espera a primeira transacao liberar o lock - se bloqueasse, isso
        // levaria pelo menos os mesmos ~400ms do sleep da primeira transacao.
        expect(secondResolvedAfterMs as number).toBeLessThan(350);
      } finally {
        await deleteRows([idA, idB]);
      }
    },
    10_000,
  );
});
