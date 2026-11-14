import { Inject, Injectable, Logger } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager, IsolationLevel } from "@mikro-orm/postgresql";
import { Money } from "../../domain/money";
import { WalletNotFoundError } from "../../domain/wallet";
import type { WalletRepository } from "../ports/wallet.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../ports/wallet.repository";
import { encodeLedgerCursor } from "../ports/wallet-ledger-entry.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../ports/wallet-ledger-entry.repository";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReconciliationMetrics } from "../reconciliation-metrics";

// Maior que o limite publico da API de paginacao (200, T303) - minimiza round-trips ao banco
// numa operacao que precisa ler o ledger inteiro; detalhe interno, nunca um contrato externo.
export const LEDGER_PAGE_SIZE = 500;

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository,
    @Inject(WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE) private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    private readonly reconciliationMetrics: ReconciliationMetrics,
    private readonly cursorSecret: string,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    // REPEATABLE READ, sem FOR UPDATE: as duas leituras abaixo (saldo + ledger) precisam ver um
    // snapshot unico e consistente - o default do Postgres (READ COMMITTED) da um snapshot novo
    // por statement, entao uma escrita concorrente comitada entre as duas leituras produziria uma
    // divergencia "falsa" (artefato de leitura em dois instantes, nao um bug real). Lock
    // pessimista (FOR UPDATE) foi rejeitado por competir com debito/credito normal da wallet.
    return this.em.transactional(() => this.reconcile(walletId), { isolationLevel: IsolationLevel.REPEATABLE_READ });
  }

  private async reconcile(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const currency = wallet.balance.currency;
    let calculatedBalance = Money.zero(currency);
    let checkedEntries = 0;
    let cursor: string | undefined;

    while (true) {
      const page = await this.walletLedgerEntryRepository.findByWalletId(walletId, { cursor, limit: LEDGER_PAGE_SIZE });
      for (const entry of page) {
        calculatedBalance =
          entry.direction === "CREDIT" ? calculatedBalance.add(entry.money) : calculatedBalance.subtract(entry.money);
        checkedEntries += 1;
      }
      if (page.length < LEDGER_PAGE_SIZE) {
        break;
      }
      const last = page[page.length - 1];
      if (!last) {
        break;
      }
      cursor = encodeLedgerCursor(last, this.cursorSecret);
    }

    const difference = wallet.balance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      // Objeto fundido pelo PinoLoggerService (T305), nunca JSON.stringify como string da
      // mensagem - isso dobraria a serializacao (o JSON inteiro apareceria escapado dentro de
      // "msg" em vez de como campos de primeiro nivel da linha).
      this.logger.error(
        {
          event: "wallet_reconciliation_divergence",
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculatedBalance.toJSON(),
          difference: difference.toJSON(),
        },
        "wallet reconciliation divergence detected",
      );
      this.reconciliationMetrics.recordDivergence();
    }

    return {
      walletId,
      storedBalance: wallet.balance,
      calculatedBalance,
      difference,
      consistent,
      checkedEntries,
    };
  }
}
