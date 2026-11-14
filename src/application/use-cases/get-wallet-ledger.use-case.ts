import { Injectable } from "@nestjs/common";
import { encodeLedgerCursor } from "../ports/wallet-ledger-entry.repository";
import type { WalletLedgerEntryRepository } from "../ports/wallet-ledger-entry.repository";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { GetWalletUseCase } from "./get-wallet.use-case";

export interface GetWalletLedgerCommand {
  walletId: string;
  cursor?: string;
  limit: number;
}

export interface GetWalletLedgerResult {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    private readonly cursorSecret: string,
  ) {}

  async execute(command: GetWalletLedgerCommand): Promise<GetWalletLedgerResult> {
    await this.getWalletUseCase.execute(command.walletId);

    const entries = await this.walletLedgerEntryRepository.findByWalletId(command.walletId, {
      cursor: command.cursor,
      limit: command.limit,
    });

    const lastEntry = entries[entries.length - 1];
    return {
      entries,
      ...(lastEntry ? { nextCursor: encodeLedgerCursor(lastEntry, this.cursorSecret) } : {}),
    };
  }
}
