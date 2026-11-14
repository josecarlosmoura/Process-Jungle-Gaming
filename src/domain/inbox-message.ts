export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessageAlreadyProcessedError extends Error {
  constructor(consumerName: string, messageId: string) {
    super(`InboxMessage "${consumerName}"/"${messageId}" was already processed`);
    this.name = "InboxMessageAlreadyProcessedError";
  }
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; receivedAt: Date }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InboxMessageAlreadyProcessedError(this.consumerName, this.messageId);
    }
    this._processedAt = at;
  }
}
