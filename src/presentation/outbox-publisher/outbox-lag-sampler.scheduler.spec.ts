import { describe, expect, test, beforeEach } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import { OutboxLagSamplerScheduler } from "./outbox-lag-sampler.scheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// RequestContext.create (MikroORM) exige um EntityManager real o bastante para forkar - fork()
// devolvendo a si mesmo e suficiente, já que nenhum destes testes faz nenhuma query de verdade
// (o repositório é todo fake).
function fakeOrm(): MikroORM {
  const em = { name: "default", fork: () => em };
  return { em } as unknown as MikroORM;
}

function fakeRepository(oldestOccurredAt: Date | null): OutboxMessageRepository {
  return {
    save: async () => undefined,
    claimPendingBatch: async () => [],
    updateDeliveryState: async () => undefined,
    findOldestPendingOccurredAt: async () => oldestOccurredAt,
  };
}

function metricsLagValue(text: string): number | undefined {
  const match = text.match(/^outbox_lag_seconds\s+([0-9.eE+-]+)$/m);
  return match ? Number(match[1]) : undefined;
}

beforeEach(() => {
  MetricsService.resetForTesting();
});

describe("OutboxLagSamplerScheduler", () => {
  test("sets outbox_lag_seconds to 0 when there is no pending message", async () => {
    const scheduler = new OutboxLagSamplerScheduler(fakeOrm(), fakeRepository(null), 10_000);

    try {
      scheduler.onApplicationBootstrap();
      await wait(30);

      expect(metricsLagValue(await MetricsService.getMetricsText())).toBe(0);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("sets outbox_lag_seconds to now() - occurredAt of the oldest pending message", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const scheduler = new OutboxLagSamplerScheduler(fakeOrm(), fakeRepository(tenMinutesAgo), 10_000);

    try {
      scheduler.onApplicationBootstrap();
      await wait(30);

      const lag = metricsLagValue(await MetricsService.getMetricsText());
      expect(lag).toBeDefined();
      expect(lag as number).toBeGreaterThan(590);
      expect(lag as number).toBeLessThan(610);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  test("the lag keeps growing across cycles when nothing publishes - independent of any publisher", async () => {
    // Nenhum OutboxPublisherScheduler/PublishOutboxUseCase existe neste teste - a prova mais
    // forte de independencia e que o lag sobe sem que nenhum codigo de publicacao exista no
    // cenario, nao so que ele "nao impede" de subir.
    const fixedOldMessage = new Date(Date.now() - 1000);
    const scheduler = new OutboxLagSamplerScheduler(fakeOrm(), fakeRepository(fixedOldMessage), 20);

    try {
      scheduler.onApplicationBootstrap();
      await wait(30);
      const firstLag = metricsLagValue(await MetricsService.getMetricsText()) as number;

      await wait(60);
      const secondLag = metricsLagValue(await MetricsService.getMetricsText()) as number;

      expect(secondLag).toBeGreaterThan(firstLag);
    } finally {
      scheduler.onModuleDestroy();
    }
  });
});
