import { Inject, Injectable } from "@nestjs/common";
import { WagerTransactionNotFoundError } from "../../domain/wager-transaction";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { WagerTransactionRepository } from "../ports/wager-transaction.repository";
import { WAGER_TRANSACTION_REPOSITORY_INTERFACE } from "../ports/wager-transaction.repository";

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_INTERFACE) private readonly wagerTransactionRepository: WagerTransactionRepository,
  ) {}

  async execute(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.wagerTransactionRepository.findById(transactionId);
    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return transaction;
  }
}
