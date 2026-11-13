import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import { Wallet, WalletAlreadyExistsError } from "../../domain/wallet";
import { WagerTransaction } from "../../domain/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletRepository } from "../ports/wallet.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../ports/wallet.repository";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../ports/wager-transaction.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../ports/wallet-ledger-entry.repository";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE)
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE)
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    try {
      return await this.em.transactional(() => this.createWallet(command));
    } catch (error) {
      // Ultima linha de defesa contra a corrida entre duas requisicoes que passam pela checagem
      // de unicidade acima ao mesmo tempo - so a constraint "wallets_player_id_currency_unique"
      // do banco decide quem vence.
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
      }
      throw error;
    }
  }

  private async createWallet(command: CreateWalletCommand): Promise<Wallet> {
    const existing = await this.walletRepository.findByPlayerAndCurrency(
      command.playerId,
      command.initialBalance.currency,
    );
    if (existing) {
      throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
    }

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
    });
    await this.walletRepository.save(wallet);

    if (command.initialBalance.isPositive()) {
      await this.openWithInitialBalance(wallet, command.initialBalance);
    }

    return wallet;
  }

  private async openWithInitialBalance(wallet: Wallet, initialBalance: Money): Promise<void> {
    const openingTransaction = WagerTransaction.createOpening({
      id: randomUUID(),
      idempotencyKey: `internal:${wallet.id}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: initialBalance,
    });
    openingTransaction.markProcessed(undefined, new Date());
    await this.wagerTransactionRepository.save(openingTransaction);

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: openingTransaction.id,
      direction: "CREDIT",
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
    });
    await this.walletLedgerEntryRepository.save(ledgerEntry);
  }
}
