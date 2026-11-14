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
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { GetWagerTransactionUseCase } from "../../application/use-cases/get-wager-transaction.use-case";
import { ReferenceResolver } from "../../application/reference-resolver";
import { WageringController } from "./wagering.controller";

@Module({
  imports: [DatabaseModule, AppConfigModule, DomainErrorHandlingModule],
  controllers: [WageringController],
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
    ProcessWagerTransactionUseCase,
    GetWagerTransactionUseCase,
  ],
  // SqsConsumerModule precisa injetar literalmente esta mesma instancia - nunca reconstruir o
  // provider com sua propria fiacao de repositorios (CLAUDE.md: "reutilizando EXATAMENTE o mesmo
  // use case" entre HTTP e SQS).
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
