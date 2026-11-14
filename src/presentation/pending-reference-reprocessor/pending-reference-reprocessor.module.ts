import { Module } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { OutboxMessageMikroOrmRepository } from "../../infrastructure/persistence/outbox-message.repository";
import { WagerTransactionMikroOrmRepository } from "../../infrastructure/persistence/wager-transaction.repository";
import { WalletLedgerEntryMikroOrmRepository } from "../../infrastructure/persistence/wallet-ledger-entry.repository";
import { WalletMikroOrmRepository } from "../../infrastructure/persistence/wallet.repository";
import { OUTBOX_MESSAGE_REPOSITORY_INTERFACE } from "../../application/ports/outbox-message.repository";
import type { OutboxMessageRepository } from "../../application/ports/outbox-message.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../../application/ports/wager-transaction.repository";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../../application/ports/wallet-ledger-entry.repository";
import type { WalletLedgerEntryRepository } from "../../application/ports/wallet-ledger-entry.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../../application/ports/wallet.repository";
import type { WalletRepository } from "../../application/ports/wallet.repository";
import { ReferenceResolver } from "../../application/reference-resolver";
import { ReprocessPendingReferenceUseCase } from "../../application/use-cases/reprocess-pending-reference.use-case";
import { PendingReferenceReprocessorScheduler } from "./pending-reference-reprocessor.scheduler";

@Module({
  imports: [DatabaseModule, AppConfigModule],
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
    ReferenceResolver,
    {
      provide: ReprocessPendingReferenceUseCase,
      useFactory: (
        em: EntityManager,
        walletRepository: WalletRepository,
        wagerTransactionRepository: WagerTransactionRepository,
        walletLedgerEntryRepository: WalletLedgerEntryRepository,
        outboxMessageRepository: OutboxMessageRepository,
        referenceResolver: ReferenceResolver,
        config: AppConfigService,
      ) =>
        new ReprocessPendingReferenceUseCase(
          em,
          walletRepository,
          wagerTransactionRepository,
          walletLedgerEntryRepository,
          outboxMessageRepository,
          referenceResolver,
          config.pendingReferenceReprocessorBatchSize,
        ),
      inject: [
        EntityManager,
        WALLET_REPOSITORY_INTERFACE,
        WAGER_TRANSACTION_REPOSITORY_INTERFACE,
        WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE,
        OUTBOX_MESSAGE_REPOSITORY_INTERFACE,
        ReferenceResolver,
        AppConfigService,
      ],
    },
    {
      provide: PendingReferenceReprocessorScheduler,
      useFactory: (orm: MikroORM, useCase: ReprocessPendingReferenceUseCase, config: AppConfigService) =>
        new PendingReferenceReprocessorScheduler(orm, useCase, config.pendingReferenceReprocessorPollIntervalMs),
      inject: [MikroORM, ReprocessPendingReferenceUseCase, AppConfigService],
    },
  ],
})
export class PendingReferenceReprocessorModule {}
