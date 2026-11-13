import { BadRequestException, Body, Controller, Headers, HttpException, HttpStatus, NotFoundException, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import {
  IdempotencyConflictError,
  LockAcquisitionTimeoutError,
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
  UnsupportedWagerTransactionKindError,
} from "../../application/use-cases/process-wager-transaction.use-case";
import { InvalidMoneyAmountError, Money, type MoneyProps } from "../../domain/money";
import { WalletNotFoundError } from "../../domain/wallet";

const processWagerTransactionBodySchema = z.object({
  providerId: z.string().min(1),
  externalTransactionId: z.string().min(1),
  playerId: z.string().min(1),
  walletId: z.string().uuid(),
  roundId: z.string().min(1),
  gameId: z.string().min(1),
  // Validado como string livre, nao enum: identificar qual "kind" nao e suportado (AC 10) e
  // decisao do use case (nunca espalhada no controller), nao do contrato HTTP.
  kind: z.string().min(1),
  money: z.object({
    amount: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code"),
  }),
  referenceExternalTransactionId: z.string().min(1).optional(),
});

interface ProcessWagerTransactionResponseBody {
  transactionId: string;
  status: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

@Controller("wagering/transactions")
export class WageringController {
  constructor(private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase) {}

  @Post()
  async create(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey) {
      throw new BadRequestException('header "Idempotency-Key" is required');
    }

    const parsed = processWagerTransactionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    }

    const money = this.parseMoney(parsed.data.money);

    let result: ProcessWagerTransactionResult;
    try {
      result = await this.processWagerTransactionUseCase.execute({
        idempotencyKey,
        providerId: parsed.data.providerId,
        externalTransactionId: parsed.data.externalTransactionId,
        playerId: parsed.data.playerId,
        walletId: parsed.data.walletId,
        roundId: parsed.data.roundId,
        gameId: parsed.data.gameId,
        kind: parsed.data.kind,
        money,
        referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
      });
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof LockAcquisitionTimeoutError) {
        throw new HttpException({ failureCode: "INTERNAL_ERROR" }, HttpStatus.SERVICE_UNAVAILABLE);
      }
      if (error instanceof IdempotencyConflictError) {
        throw new HttpException({ failureCode: "IDEMPOTENCY_CONFLICT" }, HttpStatus.CONFLICT);
      }
      if (error instanceof UnsupportedWagerTransactionKindError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    res.status(this.statusFor(result)).json(this.toResponseBody(result));
  }

  private statusFor(result: ProcessWagerTransactionResult): number {
    if (result.status === "REJECTED") {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }
    return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
  }

  private toResponseBody(result: ProcessWagerTransactionResult): ProcessWagerTransactionResponseBody {
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }

  private parseMoney(props: { amount: string; currency: string }): Money {
    try {
      return Money.from(props);
    } catch (error) {
      if (error instanceof InvalidMoneyAmountError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
