import { createHash } from "node:crypto";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { RequestContext } from "@mikro-orm/core";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { MikroORM } from "@mikro-orm/postgresql";
import { DeleteMessageCommand, GetQueueUrlCommand, type Message, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { SQSClient } from "@aws-sdk/client-sqs";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ConsumeWagerTransactionMessageUseCase } from "../../application/use-cases/consume-wager-transaction-message.use-case";
import { isTransientInfrastructureFailure } from "../../domain/domain-error";
import { WAGER_TRANSACTIONS_CONSUMER_NAME } from "../../infrastructure/messaging/queue-names";
import { parseWagerTransactionRequestedEnvelope, toProcessWagerTransactionCommand } from "./wager-transaction-requested-envelope";

// Pausa curta entre tentativas de ReceiveMessageCommand quando a propria chamada falha (ex.:
// LocalStack fora do ar) - sem isto, uma falha persistente giraria em busy-loop.
const RECEIVE_FAILURE_RETRY_DELAY_MS = 1_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Adaptador fino, mesmo nivel de "gatilho de borda" que WageringController/OutboxPublisherScheduler
// (CLAUDE.md) - nunca decide nada de negocio, so traduz a mensagem e decide ack/retry a partir do
// que ConsumeWagerTransactionMessageUseCase devolveu ou lancou.
@Injectable()
export class WagerTransactionSqsConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionSqsConsumer.name);
  private stopped = false;
  private loopPromise?: Promise<void>;
  private queueUrlPromise?: Promise<string>;
  // Aborta o ReceiveMessageCommand em voo no sinal de parada - sem isto, onModuleDestroy ficaria
  // esperando o long polling (WaitTimeSeconds) terminar por conta propria antes de resolver, que
  // pode levar ate 20s mesmo sem nenhuma mensagem real em processamento.
  private receiveAbortController?: AbortController;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqsClient: SQSClient,
    private readonly consumeWagerTransactionMessageUseCase: ConsumeWagerTransactionMessageUseCase,
    private readonly waitTimeSeconds: number,
    // Configuravel (default "wager-transactions.fifo", AppConfigService.wagerTransactionsQueueName)
    // so para permitir que um teste de integracao isole o consumer numa fila FIFO descartavel
    // propria, sem competir com nenhuma instancia real da app rodando ao lado pela mesma fila.
    private readonly queueName: string,
  ) {}

  onApplicationBootstrap(): void {
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.logger.log("parando de receber novas mensagens de wager-transactions.fifo");
    // Cancela o ReceiveMessageCommand em voo imediatamente - se nao houver nenhuma mensagem
    // sendo processada, nao ha motivo para esperar o long polling esgotar por conta propria.
    this.receiveAbortController?.abort();
    // Uma mensagem em voo de verdade (handleMessage ja chamado) nunca e abortada aqui - o proprio
    // runLoop continua aguardando ela normalmente ate ack ou rollback-sem-ack antes deste await
    // devolver o controle.
    await this.loopPromise;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      // Criado aqui, antes de qualquer await desta iteracao - nunca dentro de receiveMessages()
      // depois do await de resolveQueueUrl(), onde onModuleDestroy poderia chamar abort() num
      // controller ainda indefinido (corrida real: esse exato bug fazia onModuleDestroy nunca
      // cancelar o ReceiveMessageCommand de fato, esperando o WaitTimeSeconds inteiro).
      this.receiveAbortController = new AbortController();
      let messages: Message[];
      try {
        messages = await this.receiveMessages(this.receiveAbortController.signal);
      } catch (error) {
        if (this.stopped) {
          // receiveMessages() foi abortado de proposito por onModuleDestroy - nao e uma falha
          // real de infraestrutura, nunca loga nem espera antes de sair do loop.
          return;
        }
        this.logger.error(
          "failed to receive messages from wager-transactions.fifo",
          error instanceof Error ? error.stack : String(error),
        );
        await wait(RECEIVE_FAILURE_RETRY_DELAY_MS);
        continue;
      }
      for (const message of messages) {
        await this.handleMessage(message);
      }
    }
  }

  private async receiveMessages(abortSignal: AbortSignal): Promise<Message[]> {
    const queueUrl = await this.resolveQueueUrl();
    const result = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        // MaxNumberOfMessages=1: processamento estritamente sequencial - nunca ha uma segunda
        // mensagem "em voo, ainda nao iniciada" no momento de um SIGTERM, entao nunca precisa
        // devolver visibilidade explicitamente (plan.md Assumptions).
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitTimeSeconds,
      }),
      { abortSignal },
    );
    return result.Messages ?? [];
  }

  private async handleMessage(message: Message): Promise<void> {
    const body = message.Body ?? "";
    let messageId: string;
    let command: ReturnType<typeof toProcessWagerTransactionCommand>;
    try {
      // toProcessWagerTransactionCommand roda aqui, na MESMA etapa de traducao que o parse do
      // envelope - nunca dentro do try que decide ack/retry a partir do use case. Money.from()
      // (chamado por toProcessWagerTransactionCommand) pode lancar InvalidMoneyAmountError para
      // um "amount" malformado que o schema do envelope (so z.string()) nao pega - um erro de
      // payload tao permanente quanto um JSON invalido, nunca classificavel pelo mesmo caminho
      // dos erros que o USE CASE lanca (isTransientInfrastructureFailure aqui decide so entre
      // "ack direto" e "deixa redelivery natural tentar de novo", nunca entre categorias do use case).
      const envelope = parseWagerTransactionRequestedEnvelope(body);
      messageId = envelope.messageId;
      command = toProcessWagerTransactionCommand(envelope);
    } catch (error) {
      if (isTransientInfrastructureFailure(error)) {
        // Erro inesperado (nunca deveria acontecer so traduzindo uma mensagem) - tratado como
        // transitorio por seguranca: nunca ack de algo que ninguem classificou, deixa redelivery
        // natural tentar de novo.
        this.logger.error(
          `unexpected failure translating SQS message, it will be redelivered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      // Payload que nunca vai se consertar reenviando - ack direto, sem abrir transacao (mesmo
      // principio do BadRequestException do controller HTTP, que tambem nao grava nada).
      this.logger.error(
        `invalid SQS message body, deleting without processing: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.deleteMessage(message);
      return;
    }

    try {
      await RequestContext.create(this.orm.em, () =>
        this.consumeWagerTransactionMessageUseCase.execute({
          consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
          messageId,
          payloadHash: createHash("sha256").update(body).digest("hex"),
          wagerTransactionCommand: command,
        }),
      );
      await this.deleteMessage(message);
    } catch (error) {
      // Transacao inteira ja foi abortada dentro do use case - nunca ack aqui. A mensagem volta a
      // visibilidade da fila apos o VisibilityTimeout, para redelivery com o backoff da propria fila.
      this.logger.error(
        `transient failure processing message "${messageId}", it will be redelivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async deleteMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle) {
      return;
    }
    const queueUrl = await this.resolveQueueUrl();
    await this.sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private resolveQueueUrl(): Promise<string> {
    if (!this.queueUrlPromise) {
      this.queueUrlPromise = this.sqsClient
        .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
        .then((result) => {
          if (!result.QueueUrl) {
            throw new Error(`SQS did not return a QueueUrl for "${this.queueName}"`);
          }
          return result.QueueUrl;
        })
        .catch((error: unknown) => {
          this.queueUrlPromise = undefined;
          throw error;
        });
    }
    return this.queueUrlPromise;
  }
}
