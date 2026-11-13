import { Module } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { AppConfigModule } from "../../infrastructure/config/app-config.module";
import { AppConfigService } from "../../infrastructure/config/app-config.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { DomainErrorHandlingModule } from "../common/domain-error-handling.module";
import { WalletMikroOrmRepository } from "../../infrastructure/persistence/wallet.repository";
import { WagerTransactionMikroOrmRepository } from "../../infrastructure/persistence/wager-transaction.repository";
import { WalletLedgerEntryMikroOrmRepository } from "../../infrastructure/persistence/wallet-ledger-entry.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../../application/ports/wallet.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../../application/ports/wager-transaction.repository";
import { WALLET_LEDGER_ENTRY_REPOSITORY_INTERFACE } from "../../application/ports/wallet-ledger-entry.repository";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
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
    CreateWalletUseCase,
    GetWalletUseCase,
  ],
})
export class WalletsModule {}
