import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { DomainErrorHandlingModule } from "../common/domain-error-handling.module";
import { WalletMikroOrmRepository } from "../../infrastructure/persistence/wallet.repository";
import { WagerTransactionMikroOrmRepository } from "../../infrastructure/persistence/wager-transaction.repository";
import { WalletLedgerEntryMikroOrmRepository } from "../../infrastructure/persistence/wallet-ledger-entry.repository";
import { OutboxMessageMikroOrmRepository } from "../../infrastructure/persistence/outbox-message.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../../application/ports/wallet.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../../application/ports/wager-transaction.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../../application/ports/wallet-ledger-entry.repository";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../../application/ports/outbox-message.repository";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../application/use-cases/get-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { ReconciliationMetrics } from "../../application/reconciliation-metrics";
import type { WalletLedgerEntryRepository } from "../../application/ports/wallet-ledger-entry.repository";
import type { WalletRepository } from "../../application/ports/wallet.repository";
import { WalletsController } from "./wallets.controller";

@Module({
  imports: [DatabaseModule, AppConfigModule, DomainErrorHandlingModule],
  controllers: [WalletsController],
  providers: [
    { provide: WALLET_REPOSITORY_INTERFACE, useClass: WalletMikroOrmRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY_INTERFACE, useClass: WagerTransactionMikroOrmRepository },
    {
      provide: WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE,
      useFactory: (em: EntityManager, config: AppConfigService) =>
        new WalletLedgerEntryMikroOrmRepository(em, config.ledgerCursorSecret),
      inject: [EntityManager, AppConfigService],
    },
    { provide: OUTBOX_MESSAGE_REPOSITORY_INTERFACE, useClass: OutboxMessageMikroOrmRepository },
    CreateWalletUseCase,
    GetWalletUseCase,
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (
        getWalletUseCase: GetWalletUseCase,
        ledgerRepository: WalletLedgerEntryRepository,
        config: AppConfigService,
      ) => new GetWalletLedgerUseCase(getWalletUseCase, ledgerRepository, config.ledgerCursorSecret),
      inject: [GetWalletUseCase, WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE, AppConfigService],
    },
    ReconciliationMetrics,
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        em: EntityManager,
        walletRepository: WalletRepository,
        ledgerRepository: WalletLedgerEntryRepository,
        metrics: ReconciliationMetrics,
        config: AppConfigService,
      ) => new ReconcileWalletUseCase(em, walletRepository, ledgerRepository, metrics, config.ledgerCursorSecret),
      inject: [
        EntityManager,
        WALLET_REPOSITORY_INTERFACE,
        WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE,
        ReconciliationMetrics,
        AppConfigService,
      ],
    },
  ],
})
export class WalletsModule {}
