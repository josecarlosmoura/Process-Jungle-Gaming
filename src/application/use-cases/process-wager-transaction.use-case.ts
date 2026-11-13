import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { DriverException, EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { PayloadValidationError, ResourceConflictError, TransientInfrastructureError } from "../../domain/domain-error";
import { CurrencyMismatchError, type Money, type MoneyProps } from "../../domain/money";
import { InsufficientFundsError, type Wallet, WalletNotFoundError } from "../../domain/wallet";
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from "../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReferenceResolver } from "../reference-resolver";
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

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["BET", "WIN", "LOSS"]);

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE)
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE)
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    private readonly referenceResolver: ReferenceResolver,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    // Restricao temporaria, ate REFUND/ROLLBACK ganharem suporte - mora aqui, nao no controller,
    // para nao espalhar logica de negocio sobre kind pela camada de apresentacao.
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
      return this.processWithoutBalanceEffect(transaction, wallet);
    }
    return this.processWithBalanceEffect(transaction, wallet, command);
  }

  // LOSS nunca chama wallet.credit/debit, entao a consistencia de moeda (garantida de graca para
  // BET/WIN pelo proprio debit/credit) precisa de uma checagem explicita aqui - via
  // Wallet.hasCurrency, a mesma fonte que debit/credit usam internamente.
  private async processWithoutBalanceEffect(
    transaction: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    if (!wallet.hasCurrency(transaction.money.currency)) {
      transaction.reject("CURRENCY_MISMATCH");
      await this.wagerTransactionRepository.save(transaction);
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
    transaction.markProcessed(undefined, new Date(), wallet.balance);
    await this.wagerTransactionRepository.save(transaction);
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
        transaction.reject("REFERENCE_MISMATCH");
        await this.wagerTransactionRepository.save(transaction);
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
      if (error instanceof CurrencyMismatchError) {
        transaction.reject("CURRENCY_MISMATCH");
      } else if (error instanceof InsufficientFundsError) {
        transaction.reject("INSUFFICIENT_FUNDS");
      } else {
        throw error;
      }
      await this.wagerTransactionRepository.save(transaction);
      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: balanceBefore.toJSON(),
        idempotentReplay: false,
      };
    }

    transaction.markProcessed(referenceTransactionId, new Date());
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
    await this.walletRepository.save(wallet);
    // outbox.enqueue(WagerTransactionProcessed, WalletBalanceChanged, ...) entraria aqui, na
    // mesma transacao, quando a outbox existir.

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
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
