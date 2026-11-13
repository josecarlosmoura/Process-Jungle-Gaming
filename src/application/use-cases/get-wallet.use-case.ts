import { Inject, Injectable } from "@nestjs/common";
import { WalletNotFoundError } from "../../domain/wallet";
import type { Wallet } from "../../domain/wallet";
import type { WalletRepository } from "../ports/wallet.repository";
import { WALLET_REPOSITORY_INTERFACE } from "../ports/wallet.repository";

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY_INTERFACE) private readonly walletRepository: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
