import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { DriverException, EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { CurrencyMismatchError, type Money, type MoneyProps } from "../../domain/money";
import { InsufficientFundsError, WalletNotFoundError } from "../../domain/wallet";
import { WagerTransaction, type WagerTransactionStatus } from "../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
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

export class UnsupportedWagerTransactionKindError extends Error {
  constructor(public readonly kind: string) {
    super(`kind "${kind}" is not supported yet`);
    this.name = "UnsupportedWagerTransactionKindError";
  }
}

export class LockAcquisitionTimeoutError extends Error {
  constructor(walletId: string) {
    super(`Lock for wallet "${walletId}" was not acquired before lock_timeout elapsed`);
    this.name = "LockAcquisitionTimeoutError";
  }
}

// SQLSTATE do Postgres para "lock_not_available" - o conversor de excecoes do driver Postgres do
// MikroORM nao mapeia esse codigo para uma classe dedicada (so 40001/40P01 deadlock, 23xxx
// constraints, 42xxx sintaxe), entao a deteccao e pelo .code bruto preservado em DriverException.
const LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE)
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE)
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    // Restricao temporaria desta tarefa (T111/T204/T205 removem conforme os demais kinds
    // ganham suporte) - mora aqui, nao no controller, para nao espalhar logica de negocio
    // sobre kind pela camada de apresentacao.
    if (command.kind !== "BET") {
      throw new UnsupportedWagerTransactionKindError(command.kind);
    }
    try {
      return await this.em.transactional(() => this.process(command));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        // Corrida na criacao: a linha vencedora ja esta commitada por quem ganhou a corrida de
        // insercao na constraint unica de idempotency_key - releio e devolvo como replay, nunca
        // como erro, igual ao mesmo padrao ja usado por CreateWalletUseCase.
        const existing = await this.wagerTransactionRepository.findByIdempotencyKey(command.idempotencyKey);
        if (existing) {
          return this.toReplayResult(existing);
        }
      }
      if (error instanceof DriverException && (error as DriverException).code === LOCK_NOT_AVAILABLE_SQLSTATE) {
        throw new LockAcquisitionTimeoutError(command.walletId);
      }
      throw error;
    }
  }

  private async process(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    // ARCHITECTURE.md secao 5.1: teto de espera pelo lock pessimista, primeira instrucao da
    // transacao - sem isso, uma sessao travada penduraria a fila de espera daquela wallet
    // indefinidamente. em.execute() (nao getConnection().execute()) resolve o contexto
    // transacional ativo automaticamente, garantindo que este SET LOCAL rode na mesma
    // transacao/conexao do SELECT ... FOR UPDATE feito a seguir.
    await this.em.execute("set local lock_timeout = '5s'", [], "run");

    const existing = await this.wagerTransactionRepository.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return this.toReplayResult(existing);
    }

    const wallet = await this.walletRepository.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // command.kind so chega aqui como "BET" - execute() ja rejeitou qualquer outro valor antes
    // de abrir a transacao.
    const payloadHash = computeWagerTransactionPayloadHash({ ...command, kind: "BET" });
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
      kind: "BET",
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const balanceBefore = wallet.balance;
    try {
      wallet.debit(command.money);
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

    transaction.markProcessed(undefined, new Date());
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

  private async toReplayResult(transaction: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    if (transaction.status === "PROCESSED") {
      const ledgerEntry = await this.walletLedgerEntryRepository.findByTransactionId(transaction.id);
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: ledgerEntry?.balanceAfter.toJSON(),
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
