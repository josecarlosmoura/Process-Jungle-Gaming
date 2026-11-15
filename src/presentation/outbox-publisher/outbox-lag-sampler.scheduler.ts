import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { RequestContext } from "@mikro-orm/core";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { MikroORM } from "@mikro-orm/postgresql";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../../application/ports/outbox-message.repository";

// Ciclo de tempo PROPRIO, independente de OutboxPublisherScheduler - de proposito (plan.md Landing
// door 1): pausar/parar o publisher nunca deveria pausar a propria metrica que mede o atraso dele.
// So LE (findOldestPendingOccurredAt, sem lock) - nunca reivindica nem publica nada.
@Injectable()
export class OutboxLagSamplerScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxLagSamplerScheduler.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly orm: MikroORM,
    @Inject(OUTBOX_MESSAGE_REPOSITORY_INTERFACE) private readonly outboxMessageRepository: OutboxMessageRepository,
    private readonly pollIntervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduleNextCycle(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNextCycle(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      // RequestContext.create forka orm.em por ciclo - mesmo mecanismo de
      // OutboxPublisherScheduler/PendingReferenceReprocessorScheduler, para o identity map global
      // nao crescer para sempre ao longo da vida do processo.
      const oldestOccurredAt = await RequestContext.create(this.orm.em, () =>
        this.outboxMessageRepository.findOldestPendingOccurredAt(),
      );
      const lagSeconds = oldestOccurredAt ? (Date.now() - oldestOccurredAt.getTime()) / 1000 : 0;
      MetricsService.setOutboxLag(lagSeconds);
    } catch (error) {
      // Mesmo padrao de OutboxPublisherScheduler/PendingReferenceReprocessorScheduler - um ciclo
      // que falha nunca derruba o worker, so loga e segue para o proximo ciclo normalmente.
      this.logger.error("outbox lag sampler cycle failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.scheduleNextCycle(this.pollIntervalMs);
    }
  }
}
