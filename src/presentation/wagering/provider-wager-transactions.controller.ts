import { Controller, Get, Param } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWagerTransactionByProviderUseCase } from "../../application/use-cases/get-wager-transaction-by-provider.use-case";
import { toGetResponseBody, type GetWagerTransactionResponseBody } from "./wagering.controller";

@Controller("providers/:providerId/wagering/transactions")
export class ProviderWagerTransactionsController {
  constructor(private readonly getWagerTransactionByProviderUseCase: GetWagerTransactionByProviderUseCase) {}

  @Get(":externalTransactionId")
  async get(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<GetWagerTransactionResponseBody> {
    const transaction = await this.getWagerTransactionByProviderUseCase.execute({ providerId, externalTransactionId });
    return toGetResponseBody(transaction);
  }
}
