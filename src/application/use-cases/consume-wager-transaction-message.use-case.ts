import { Inject, Injectable, Logger } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { isTransientInfrastructureFailure } from "../../domain/domain-error";
import { InboxMessage } from "../../domain/inbox-message";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ProcessWagerTransactionUseCase, type ProcessWagerTransactionCommand } from "./process-wager-transaction.use-case";
import type { InboxMessageRepository } from "../ports/inbox-message.repository";
import { INBOX_MESSAGE_REPOSITORY_INTERFACE } from "../ports/inbox-message.repository";

export interface ConsumeWagerTransactionMessageCommand {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  wagerTransactionCommand: ProcessWagerTransactionCommand;
}

export type ConsumeWagerTransactionMessageOutcome = "PROCESSED" | "DUPLICATE";

export interface ConsumeWagerTransactionMessageResult {
  outcome: ConsumeWagerTransactionMessageOutcome;
}

@Injectable()
export class ConsumeWagerTransactionMessageUseCase {
  private readonly logger = new Logger(ConsumeWagerTransactionMessageUseCase.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(INBOX_MESSAGE_REPOSITORY_INTERFACE) private readonly inboxMessageRepository: InboxMessageRepository,
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
  ) {}

  async execute(command: ConsumeWagerTransactionMessageCommand): Promise<ConsumeWagerTransactionMessageResult> {
    try {
      return await this.em.transactional(() => this.process(command));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Corrida de duas instancias recebendo a mesma mensagem: a vencedora ja inseriu (e vai
        // processar/ja processou) a linha de inbox - mesmo padrao de
        // ProcessWagerTransactionUseCase para a corrida de idempotency_key. Nunca ack explicito
        // aqui: quem chama trata DUPLICATE exatamente como "ja visto", ack normal.
        return { outcome: "DUPLICATE" };
      }
      throw error;
    }
  }

  private async process(command: ConsumeWagerTransactionMessageCommand): Promise<ConsumeWagerTransactionMessageResult> {
    const existing = await this.inboxMessageRepository.findByKey(command.consumerName, command.messageId);
    if (existing) {
      return { outcome: "DUPLICATE" };
    }

    const receivedAt = new Date();
    const inboxMessage = InboxMessage.receive({
      messageId: command.messageId,
      consumerName: command.consumerName,
      payloadHash: command.payloadHash,
      receivedAt,
    });
    await this.inboxMessageRepository.insert(inboxMessage);

    try {
      await this.processWagerTransactionUseCase.execute(command.wagerTransactionCommand);
    } catch (error) {
      if (isTransientInfrastructureFailure(error)) {
        // Relanca para abortar a transacao INTEIRA (inclusive o insert de inbox acima) - quem
        // chama nunca ack essa mensagem, ela volta para redelivery. Diferente do savepoint que
        // ProcessWagerTransactionUseCase.execute() ja absorveu internamente para erros de
        // negocio: aqui a decisao e propositalmente propagar, nao continuar.
        throw error;
      }
      // Erro de negocio permanente (ex.: WalletNotFoundError, IdempotencyConflictError numa
      // corrida de negocio) - o mesmo payload produziria o mesmo erro indefinidamente, entao
      // nunca justifica retry. O savepoint que ProcessWagerTransactionUseCase.execute() abriu
      // internamente ja foi desfeito pelo MikroORM antes do erro chegar aqui; esta transacao
      // continua valida para marcar a mensagem como processada.
      this.logger.warn(
        `message "${command.messageId}" (consumer "${command.consumerName}") processed with a permanent business error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    inboxMessage.markProcessed(new Date());
    await this.inboxMessageRepository.markProcessed(inboxMessage);
    return { outcome: "PROCESSED" };
  }
}
