import { Inject, Injectable } from "@nestjs/common";
import { WagerTransactionNotFoundByProviderError } from "../../domain/wager-transaction";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../ports/wager-transaction.repository";

export interface GetWagerTransactionByProviderCommand {
  providerId: string;
  externalTransactionId: string;
}

@Injectable()
export class GetWagerTransactionByProviderUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE) private readonly wagerTransactionRepository: WagerTransactionRepository,
  ) {}

  async execute(command: GetWagerTransactionByProviderCommand): Promise<WagerTransaction> {
    const transaction = await this.wagerTransactionRepository.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundByProviderError(command.providerId, command.externalTransactionId);
    }
    return transaction;
  }
}
