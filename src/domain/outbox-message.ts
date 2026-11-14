import type { IntegrationEvent } from "./integration-event";

export class OutboxMessageAlreadyPublishedError extends Error {
  constructor(id: string) {
    super(`OutboxMessage "${id}" was already published`);
    this.name = "OutboxMessageAlreadyPublishedError";
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  // ARCHITECTURE.md secao 7: "backoff exponencial (ex.: base * 2^attempts, com jitter e teto
  // maximo)". Estes 3 numeros sao proprios da publicacao da outbox (infra transitoria, falha
  // tipicamente curta) - nao reaproveitam WagerTransaction.INITIAL_PENDING_REFERENCE_DELAY_MS,
  // que e o backoff de esperar por uma referencia de negocio ainda nao chegada, um fenomeno
  // bem mais lento.
  static readonly RETRY_BASE_DELAY_MS = 1_000;
  static readonly RETRY_MAX_DELAY_MS = 300_000;
  static readonly RETRY_JITTER_MS = 1_000;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  // id = event.eventId (um-para-um): a mensagem publicada no SQS é identificada pelo mesmo
  // eventId que o consumidor externo usa para deduplicar (RN-47), sem precisar de dois ids
  // independentes para a mesma ocorrência.
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      // O envelope tem um shape fixo (IntegrationEventEnvelope<T>), nao um record indexado -
      // outbox_messages.payload e generico para qualquer agregado futuro, entao o dominio guarda
      // só a forma genérica; a borda de persistência é quem volta a tipar isso.
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  markPublished(now: Date): void {
    if (this._publishedAt) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
    this._publishedAt = now;
  }

  // Nunca ha um failureCode/estado terminal de desistencia aqui (diferente de
  // WagerTransaction.markPendingReference, que esgota e rejeita) - um evento ja comitado nao
  // pode ser descartado sem violar "nenhum evento perdido"; so o delay tem teto, as tentativas
  // nao.
  scheduleRetry(now: Date): void {
    if (this._publishedAt) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
    this._attempts += 1;
    const exponentialDelay = OutboxMessage.RETRY_BASE_DELAY_MS * 2 ** (this._attempts - 1);
    const cappedDelay = Math.min(exponentialDelay, OutboxMessage.RETRY_MAX_DELAY_MS);
    const jitter = Math.random() * OutboxMessage.RETRY_JITTER_MS;
    this._nextAttemptAt = new Date(now.getTime() + cappedDelay + jitter);
  }
}
