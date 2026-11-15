import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import type { EventContext, IntegrationEvent } from "../../domain/integration-event";
import { OutboxMessage } from "../../domain/outbox-message";
import type { ReversalKind, WagerTransaction } from "../../domain/wager-transaction";
import { WalletNotFoundError } from "../../domain/wallet";
import { LogContextService } from "../../infrastructure/observability/log-context.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { OutboxMessageRepository } from "../ports/outbox-message.repository";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../ports/outbox-message.repository";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../ports/wager-transaction.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../ports/wallet-ledger-entry.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../ports/wallet.repository";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReferenceResolver } from "../reference-resolver";
import { REFUND_ACCEPTANCE_RULES, ROLLBACK_ACCEPTANCE_RULES, applyResolvedReversal } from "./reversal-effect";

@Injectable()
export class ReprocessPendingReferenceUseCase {
  private readonly logger = new Logger(ReprocessPendingReferenceUseCase.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE)
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE)
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    @Inject(OUTBOX_MESSAGE_REPOSITORY_INTERFACE)
    private readonly outboxMessageRepository: OutboxMessageRepository,
    private readonly referenceResolver: ReferenceResolver,
    private readonly batchSize: number,
  ) {}

  // O chamador (PendingReferenceReprocessorScheduler) e um loop de tempo, nunca uma requisicao
  // HTTP - envolve cada chamada em RequestContext.create(orm.em, ...), mesmo contrato de
  // PublishOutboxUseCase.
  async execute(): Promise<void> {
    await this.em.transactional(async () => {
      const now = new Date();
      const batch = await this.wagerTransactionRepository.claimPendingReferenceBatch(now, this.batchSize);
      // Ordena por walletId antes de travar qualquer wallet - duas instancias concorrentes, cada
      // uma com seu proprio lote disjunto (SKIP LOCKED), adquirem os locks de wallet na mesma
      // ordem relativa, o que elimina a espera circular que causaria deadlock entre dois lotes
      // que, por acaso, compartilhem duas ou mais wallets em comum.
      const ordered = [...batch].sort((a, b) => a.walletId.localeCompare(b.walletId));
      for (const transaction of ordered) {
        // Cada tentativa de reprocessamento e sua propria operacao (nao a mesma requisicao
        // original que levou a PENDING_REFERENCE) - correlationId novo por tentativa, mas um so
        // valor para toda ela: lido de volta por reprocess() para o EventContext publicado, nunca
        // gerado uma segunda vez (AC8 - nunca dois valores diferentes para a mesma tentativa).
        await LogContextService.run(
          { correlationId: randomUUID(), walletId: transaction.walletId, transactionId: transaction.id },
          () => this.reprocess(transaction, now),
        );
      }
    });
  }

  private async reprocess(transaction: WagerTransaction, now: Date): Promise<void> {
    // Mesmo teto de espera pelo lock pessimista de ProcessWagerTransactionUseCase/T108 - sem
    // isso, uma wallet contestada penduraria o lote inteiro (que ainda guarda o lock de claim das
    // demais linhas) indefinidamente.
    await this.em.execute("set local lock_timeout = '5s'", [], "run");

    const wallet = await this.walletRepository.findByIdForUpdate(transaction.walletId);
    if (!wallet) {
      // A wallet referenciada por uma WagerTransaction já persistida sempre existe - sua ausência
      // aqui seria uma violação de integridade referencial, não um caso de negócio a tratar.
      throw new WalletNotFoundError(transaction.walletId);
    }

    // LogContextService.run() em execute() ja garante um correlationId presente - o fallback
    // randomUUID() so cobre quem chama reprocess() direto (ex.: um teste de unidade sem run()).
    const ctx: EventContext = { correlationId: LogContextService.get().correlationId ?? randomUUID(), occurredAt: now };
    // claimPendingReferenceBatch só devolve PENDING_REFERENCE, que só existe para REFUND/ROLLBACK
    // (markPendingReference só é chamado por processRefund/processRollback) - o cast é seguro.
    const reversalKind = transaction.kind as ReversalKind;

    const resolution = await this.referenceResolver.resolve({
      providerId: transaction.providerId as string,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId as string,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId as string,
      money: transaction.money,
      reversalKind,
    });

    if (resolution.outcome === "NOT_FOUND") {
      // Os dois gatilhos são checados de forma independente (ARCHITECTURE.md seção 8) - o que
      // ocorrer primeiro vence, nunca um booleano combinado que poderia esconder qual dos dois
      // esgotou de fato.
      if (transaction.hasExhaustedReferenceAttempts() || transaction.hasExceededReferenceTtl(now)) {
        transaction.reject("REFERENCE_NOT_FOUND");
        await this.wagerTransactionRepository.save(transaction);
        await this.enqueue(WagerTransactionRejected.from(transaction, ctx));
        this.logger.warn(
          { event: "pending_reference_reprocess_outcome", status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND" },
          "pending reference reprocessing rejected",
        );
        return;
      }
      transaction.scheduleReferenceRetry(now);
      MetricsService.recordRetry();
      await this.wagerTransactionRepository.save(transaction);
      return;
    }

    const rules = reversalKind === "REFUND" ? REFUND_ACCEPTANCE_RULES : ROLLBACK_ACCEPTANCE_RULES;
    const effect = applyResolvedReversal(transaction, wallet, resolution, transaction.money, rules, now);

    if (effect.outcome === "REJECTED") {
      await this.wagerTransactionRepository.save(transaction);
      await this.enqueue(WagerTransactionRejected.from(transaction, ctx));
      this.logger.warn(
        { event: "pending_reference_reprocess_outcome", status: "REJECTED", failureCode: effect.failureCode },
        "pending reference reprocessing rejected",
      );
      return;
    }

    await this.wagerTransactionRepository.save(transaction);
    await this.walletLedgerEntryRepository.save(effect.ledgerEntry);
    await this.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx));
    await this.enqueue(WalletBalanceChanged.from(wallet, effect.ledgerEntry, ctx));
    this.logger.log({ event: "pending_reference_reprocess_outcome", status: "PROCESSED" }, "pending reference reprocessed");
    await this.walletRepository.save(wallet);
  }

  private async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    await this.outboxMessageRepository.save(OutboxMessage.enqueue(event));
  }
}
