import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { RequestContext } from "@mikro-orm/core";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { MikroORM } from "@mikro-orm/postgresql";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReprocessPendingReferenceUseCase } from "../../application/use-cases/reprocess-pending-reference.use-case";

// Adaptador fino de "gatilho = tempo", mesmo nivel de camada de Apresentacao que
// OutboxPublisherScheduler/DlqMonitorScheduler/WagerTransactionSqsConsumer (CLAUDE.md) - roda em
// toda instancia, sem eleicao de lider nem lock distribuido externo ao Postgres (o unico lock
// real e o FOR UPDATE SKIP LOCKED do proprio claimPendingReferenceBatch). Mesmo scaffold de
// setTimeout recursivo ja duplicado duas vezes no projeto (OutboxPublisherScheduler,
// DlqMonitorScheduler) - mantido duplicado pela terceira vez de proposito (plan.md).
@Injectable()
export class PendingReferenceReprocessorScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceReprocessorScheduler.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly reprocessPendingReferenceUseCase: ReprocessPendingReferenceUseCase,
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
    // setTimeout recursivo, nunca setInterval - uma rodada so e agendada depois que a anterior
    // termina (sucesso ou falha), entao ciclos nunca se sobrepoem quando uma rodada demora mais
    // que pollIntervalMs.
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    try {
      // RequestContext.create forka orm.em por ciclo (mesmo mecanismo que o middleware do Nest
      // usa por requisicao HTTP) - ReprocessPendingReferenceUseCase.execute() usa a mesma
      // instancia global injetada, que resolve para este fork automaticamente enquanto o
      // callback estiver ativo.
      await RequestContext.create(this.orm.em, () => this.reprocessPendingReferenceUseCase.execute());
    } catch (error) {
      // Um ciclo que falha nunca derruba o worker - so loga e segue para o proximo ciclo
      // normalmente (ex.: Postgres indisponivel no claim, ou um lock_timeout de wallet contestada).
      this.logger.error(
        "pending-reference reprocessor cycle failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.scheduleNextCycle(this.pollIntervalMs);
    }
  }
}
