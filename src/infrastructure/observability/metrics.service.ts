import { Counter, Gauge, Histogram, Registry } from "prom-client";

export type IdempotencyChannel = "http" | "inbox_sqs";

const registry = new Registry();

const wagerTransactionsTotal = new Counter({
  name: "wager_transactions_total",
  help: "Total de WagerTransaction processadas, por status e kind",
  labelNames: ["status", "kind"],
  registers: [registry],
});

const wagerTransactionDurationSeconds = new Histogram({
  name: "wager_transaction_duration_seconds",
  help: "Duracao do processamento de uma WagerTransaction, do recebimento da chamada ao commit",
  registers: [registry],
});

const idempotencyDuplicatesTotal = new Counter({
  name: "idempotency_duplicates_total",
  help: "Total de chamadas redundantes absorvidas pela idempotencia, por canal",
  labelNames: ["channel"],
  registers: [registry],
});

const retriesTotal = new Counter({
  name: "retries_total",
  help: "Total de tentativas de reprocessamento agendadas pelo outbox publisher e pelo resolvedor de referencia pendente",
  registers: [registry],
});

const dlqMessagesTotal = new Counter({
  name: "dlq_messages_total",
  help: "Total de mensagens roteadas para a dead-letter queue (delta observado por polling, nunca consumindo a fila)",
  registers: [registry],
});

const lockWaitTimeoutTotal = new Counter({
  name: "lock_wait_timeout_total",
  help: "Total de vezes que o lock pessimista da wallet nao foi obtido dentro do lock_timeout",
  registers: [registry],
});

// Gauge, nao Histograma: ARCHITECTURE.md descreve "Gauge e histograma" sob o mesmo nome, mas
// prom-client nao permite duas metricas com tipos diferentes e o mesmo nome - "amostrado
// periodicamente" e semantica de Gauge (valor no instante da amostra), nao de Histograma
// (distribuicao de observacoes por evento).
const outboxLagSeconds = new Gauge({
  name: "outbox_lag_seconds",
  help: "Atraso (now() - occurred_at) da mensagem pendente mais antiga na outbox, amostrado periodicamente",
  registers: [registry],
});

// Metodos estaticos de proposito - mesmo raciocinio de LogContextService (T305): o Registry do
// prom-client ja e por natureza um singleton de processo; uma classe injetavel via Nest DI so
// acrescentaria ceremonia sem nenhum beneficio real, e obrigaria todo modulo que mede (5+ hoje) a
// importar e registrar mais um provider so para isto.
export class MetricsService {
  static recordTransactionOutcome(status: string, kind: string): void {
    wagerTransactionsTotal.inc({ status, kind });
  }

  static observeTransactionDuration(seconds: number): void {
    wagerTransactionDurationSeconds.observe(seconds);
  }

  static recordDuplicate(channel: IdempotencyChannel): void {
    idempotencyDuplicatesTotal.inc({ channel });
  }

  static recordRetry(): void {
    retriesTotal.inc();
  }

  static recordDlqMessages(delta: number): void {
    if (delta > 0) {
      dlqMessagesTotal.inc(delta);
    }
  }

  static recordLockWaitTimeout(): void {
    lockWaitTimeoutTotal.inc();
  }

  static setOutboxLag(seconds: number): void {
    outboxLagSeconds.set(seconds);
  }

  static getMetricsText(): Promise<string> {
    return registry.metrics();
  }

  static getContentType(): string {
    return registry.contentType;
  }

  // So para teste - isola cada spec do estado acumulado pelos outros, sem precisar reconstruir o
  // Registry (que recriaria as metricas e quebraria a referencia que este modulo exporta).
  static resetForTesting(): void {
    registry.resetMetrics();
  }
}
