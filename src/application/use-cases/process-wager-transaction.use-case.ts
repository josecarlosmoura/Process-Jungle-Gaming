import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { DriverException, EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { PayloadValidationError, ResourceConflictError, TransientInfrastructureError } from "../../domain/domain-error";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import type { FailureCode } from "../../domain/failure-code";
import type { EventContext, IntegrationEvent } from "../../domain/integration-event";
import { CurrencyMismatchError, type Money, type MoneyProps } from "../../domain/money";
import { OutboxMessage } from "../../domain/outbox-message";
import { InsufficientFundsError, type Wallet, WalletNotFoundError } from "../../domain/wallet";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReferenceResolver } from "../reference-resolver";
import type { OutboxMessageRepository } from "../ports/outbox-message.repository";
import { applyResolvedReversal, REFUND_ACCEPTANCE_RULES, ROLLBACK_ACCEPTANCE_RULES } from "./reversal-effect";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../ports/outbox-message.repository";
import type { WalletRepository } from "../ports/wallet.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../ports/wallet.repository";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../ports/wager-transaction.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../ports/wallet-ledger-entry.repository";
import { computeWagerTransactionPayloadHash } from "./wager-transaction-payload-hash";

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

export class UnsupportedWagerTransactionKindError extends PayloadValidationError {
  constructor(public readonly kind: string) {
    super(`kind "${kind}" is not supported yet`);
    this.name = "UnsupportedWagerTransactionKindError";
  }
}

export class LockAcquisitionTimeoutError extends TransientInfrastructureError {
  constructor(walletId: string) {
    super(`Lock for wallet "${walletId}" was not acquired before lock_timeout elapsed`);
    this.name = "LockAcquisitionTimeoutError";
  }
}

export class IdempotencyConflictError extends ResourceConflictError {
  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" was already used with a different payload`, "IDEMPOTENCY_CONFLICT");
    this.name = "IdempotencyConflictError";
  }
}

// SQLSTATE do Postgres para "lock_not_available" - o conversor de excecoes do driver Postgres do
// MikroORM nao mapeia esse codigo para uma classe dedicada (so 40001/40P01 deadlock, 23xxx
// constraints, 42xxx sintaxe), entao a deteccao e pelo .code bruto preservado em DriverException.
const LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]);

@Injectable()
export class ProcessWagerTransactionUseCase {
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
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    // Mora aqui, nao no controller, para nao espalhar logica de negocio sobre kind pela camada
    // de apresentacao.
    if (!SUPPORTED_KINDS.has(command.kind)) {
      throw new UnsupportedWagerTransactionKindError(command.kind);
    }
    // command.kind so chega aqui dentro de SUPPORTED_KINDS - computado antes de abrir a
    // transacao para que o catch da corrida de insercao abaixo possa comparar contra a linha
    // vencedora sem precisar recalcular o hash dentro de uma transacao ja abortada.
    const kind = command.kind as WagerTransactionKind;
    const payloadHash = computeWagerTransactionPayloadHash({ ...command, kind });
    try {
      return await this.em.transactional(() => this.process(command, kind, payloadHash));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Corrida na criacao: a linha vencedora ja esta commitada por quem ganhou a corrida de
        // insercao na constraint unica de idempotency_key - releio e decido entre replay e
        // conflito pelo mesmo criterio usado quando a linha e encontrada antes do INSERT. A
        // perdedora nunca deve ser tratada como replay da vencedora so porque os payloads
        // colidiram na mesma Idempotency-Key.
        const existing = await this.wagerTransactionRepository.findByIdempotencyKey(command.idempotencyKey);
        if (existing) {
          return this.resolveExisting(existing, payloadHash);
        }
      }
      if (error instanceof DriverException && (error as DriverException).code === LOCK_NOT_AVAILABLE_SQLSTATE) {
        throw new LockAcquisitionTimeoutError(command.walletId);
      }
      throw error;
    }
  }

  private async process(
    command: ProcessWagerTransactionCommand,
    kind: WagerTransactionKind,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    // ARCHITECTURE.md secao 5.1: teto de espera pelo lock pessimista, primeira instrucao da
    // transacao - sem isso, uma sessao travada penduraria a fila de espera daquela wallet
    // indefinidamente. em.execute() (nao getConnection().execute()) resolve o contexto
    // transacional ativo automaticamente, garantindo que este SET LOCAL rode na mesma
    // transacao/conexao do SELECT ... FOR UPDATE feito a seguir.
    await this.em.execute("set local lock_timeout = '5s'", [], "run");

    const existing = await this.wagerTransactionRepository.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return this.resolveExisting(existing, payloadHash);
    }

    const wallet = await this.walletRepository.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // Um correlationId novo por chamada - nem este caso de uso nem o worker de entrada (HTTP hoje,
    // SQS em T210) ainda propagam um id de correlação de borda, então gerar aqui é o único ponto
    // de entrada disponível (ARCHITECTURE.md secao 12 cobre a propagação real como trabalho futuro).
    const ctx: EventContext = { correlationId: randomUUID(), occurredAt: new Date() };

    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    if (!transaction.affectsBalance()) {
      return this.processWithoutBalanceEffect(transaction, wallet, ctx);
    }
    if (transaction.kind === "REFUND") {
      return this.processRefund(transaction, wallet, command, ctx);
    }
    if (transaction.kind === "ROLLBACK") {
      return this.processRollback(transaction, wallet, command, ctx);
    }
    return this.processWithBalanceEffect(transaction, wallet, command, ctx);
  }

  // LOSS nunca chama wallet.credit/debit, entao a consistencia de moeda (garantida de graca para
  // BET/WIN pelo proprio debit/credit) precisa de uma checagem explicita aqui - via
  // Wallet.hasCurrency, a mesma fonte que debit/credit usam internamente.
  private async processWithoutBalanceEffect(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    if (!wallet.hasCurrency(transaction.money.currency)) {
      await this.rejectTransaction(transaction, "CURRENCY_MISMATCH", ctx);
      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    // Snapshot do saldo no momento do processamento: LOSS nunca ganha um WalletLedgerEntry, que
    // e a unica outra fonte de "saldo congelado naquele momento" que toReplayResult usa para
    // BET/WIN - sem isso, um replay depois de outra transacao mover o saldo devolveria o saldo
    // atual (errado), nao o observado originalmente.
    transaction.markProcessed(undefined, ctx.occurredAt, wallet.balance);
    await this.wagerTransactionRepository.save(transaction);
    // LOSS nunca move saldo (RN-50): so WagerTransactionProcessed, nunca WalletBalanceChanged -
    // o gatilho mais facil de implementar errado "copiando o padrao de BET".
    await this.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx));
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processWithBalanceEffect(
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    let referenceTransactionId: string | undefined;
    if (transaction.kind === "WIN" && command.referenceExternalTransactionId) {
      const resolution = await this.referenceResolver.resolve({
        providerId: command.providerId,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        money: command.money,
      });
      // A referencia opcional de WIN so aceita uma BET - qualquer outro outcome do resolver
      // (incluindo RESOLVED para um kind diferente de BET) rejeita por completo, nunca processa
      // ignorando a referencia em silencio. Essa checagem de "kind aceitavel" e responsabilidade
      // de quem chama, nao do ReferenceResolver (REFUND/ROLLBACK aceitam outros kinds).
      if (resolution.outcome !== "RESOLVED" || resolution.reference.kind !== "BET") {
        await this.rejectTransaction(transaction, "REFERENCE_MISMATCH", ctx);
        return {
          transactionId: transaction.id,
          status: transaction.status,
          failureCode: transaction.failureCode,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
        };
      }
      referenceTransactionId = resolution.reference.id;
    }

    const balanceBefore = wallet.balance;
    try {
      if (transaction.kind === "BET") {
        wallet.debit(command.money);
      } else {
        wallet.credit(command.money);
      }
    } catch (error) {
      let code: FailureCode;
      if (error instanceof CurrencyMismatchError) {
        code = "CURRENCY_MISMATCH";
      } else if (error instanceof InsufficientFundsError) {
        code = "INSUFFICIENT_FUNDS";
      } else {
        throw error;
      }
      await this.rejectTransaction(transaction, code, ctx);
      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: balanceBefore.toJSON(),
        idempotentReplay: false,
      };
    }

    transaction.markProcessed(referenceTransactionId, ctx.occurredAt);
    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: transaction.ledgerDirectionFor(),
      money: command.money,
      balanceBefore,
      balanceAfter: wallet.balance,
    });

    await this.wagerTransactionRepository.save(transaction);
    await this.walletLedgerEntryRepository.save(ledgerEntry);
    await this.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx));
    await this.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx));
    // walletRepository.save fica depois do enqueue de proposito: o teste de atomicidade (S6)
    // forca a falha nesse ultimo passo e prova que tudo antes dele - inclusive o insert da
    // outbox - e desfeito junto pela mesma transacao SQL.
    await this.walletRepository.save(wallet);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processRefund(
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    // WagerTransaction.create() ja exige referenceExternalTransactionId para "REFUND", e o zod do
    // controller rejeita a ausencia como INVALID_PAYLOAD antes de chegar aqui - garantido presente.
    const resolution = await this.referenceResolver.resolve({
      providerId: command.providerId,
      referenceExternalTransactionId: command.referenceExternalTransactionId as string,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      money: command.money,
      reversalKind: "REFUND",
    });

    if (resolution.outcome === "NOT_FOUND") {
      // A referencia obrigatoria de um REFUND ainda pode se resolver depois (worker de
      // reprocessamento, T212), entao nunca rejeita de imediato so por ainda nao existir -
      // diferente da referencia opcional de WIN, que rejeita qualquer outcome que nao seja RESOLVED.
      transaction.markPendingReference(ctx.occurredAt);
      await this.wagerTransactionRepository.save(transaction);
      await this.enqueue(WagerTransactionPendingReference.from(transaction, ctx));
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const effect = applyResolvedReversal(transaction, wallet, resolution, command.money, REFUND_ACCEPTANCE_RULES, ctx.occurredAt);
    return this.finalizeReversalEffect(transaction, wallet, effect, ctx);
  }

  private async processRollback(
    transaction: WagerTransaction,
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    // WagerTransaction.create() ja exige referenceExternalTransactionId para "ROLLBACK", e o zod
    // do controller rejeita a ausencia como INVALID_PAYLOAD antes de chegar aqui - garantido presente.
    const resolution = await this.referenceResolver.resolve({
      providerId: command.providerId,
      referenceExternalTransactionId: command.referenceExternalTransactionId as string,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      money: command.money,
      reversalKind: "ROLLBACK",
    });

    if (resolution.outcome === "NOT_FOUND") {
      // Mesmo caminho de REFUND: a referencia obrigatoria ainda pode se resolver depois (worker
      // de reprocessamento, T212), nunca rejeita de imediato so por ainda nao existir.
      transaction.markPendingReference(ctx.occurredAt);
      await this.wagerTransactionRepository.save(transaction);
      await this.enqueue(WagerTransactionPendingReference.from(transaction, ctx));
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const effect = applyResolvedReversal(transaction, wallet, resolution, command.money, ROLLBACK_ACCEPTANCE_RULES, ctx.occurredAt);
    return this.finalizeReversalEffect(transaction, wallet, effect, ctx);
  }

  // Compartilhado por processRefund/processRollback - o efeito (crédito/débito, failureCode) já
  // foi decidido por applyResolvedReversal(); aqui só persiste e publica, nunca re-rejeita (a
  // transação já pode estar REJECTED quando effect.outcome é "REJECTED").
  private async finalizeReversalEffect(
    transaction: WagerTransaction,
    wallet: Wallet,
    effect: ReturnType<typeof applyResolvedReversal>,
    ctx: EventContext,
  ): Promise<ProcessWagerTransactionResult> {
    if (effect.outcome === "REJECTED") {
      await this.wagerTransactionRepository.save(transaction);
      await this.enqueue(WagerTransactionRejected.from(transaction, ctx));
      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: effect.failureCode,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    await this.wagerTransactionRepository.save(transaction);
    await this.walletLedgerEntryRepository.save(effect.ledgerEntry);
    await this.enqueue(WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx));
    await this.enqueue(WalletBalanceChanged.from(wallet, effect.ledgerEntry, ctx));
    await this.walletRepository.save(wallet);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectTransaction(transaction: WagerTransaction, code: FailureCode, ctx: EventContext): Promise<void> {
    transaction.reject(code);
    await this.wagerTransactionRepository.save(transaction);
    await this.enqueue(WagerTransactionRejected.from(transaction, ctx));
  }

  private async enqueue(event: IntegrationEvent<unknown>): Promise<void> {
    await this.outboxMessageRepository.save(OutboxMessage.enqueue(event));
  }

  // A mesma Idempotency-Key com o mesmo payloadHash e replay (devolve o resultado original, sem
  // reaplicar nada); com payloadHash diferente e conflito, nunca replay - mesmo quando a
  // transacao existente ja terminou REJECTED/FAILED, que so e replay para uma repeticao exata do
  // mesmo payload.
  private resolveExisting(existing: WagerTransaction, payloadHash: string): Promise<ProcessWagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }
    return this.toReplayResult(existing);
  }

  private async toReplayResult(transaction: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    if (transaction.status === "PROCESSED") {
      const ledgerEntry = await this.walletLedgerEntryRepository.findByTransactionId(transaction.id);
      if (ledgerEntry) {
        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: ledgerEntry.balanceAfter.toJSON(),
          idempotentReplay: true,
        };
      }
      // LOSS PROCESSED nunca gera ledger entry - o saldo observado naquele momento vem do
      // snapshot gravado por markProcessed(), nunca do saldo atual da wallet (que pode ja ter
      // sido alterado por outra transacao entre o processamento original e este replay).
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: transaction.balanceAfterProcessing?.toJSON(),
        idempotentReplay: true,
      };
    }
    const wallet = await this.walletRepository.findById(transaction.walletId);
    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: wallet?.balance.toJSON(),
      idempotentReplay: true,
    };
  }
}
