import { BadRequestException, Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
} from "../../application/use-cases/process-wager-transaction.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWagerTransactionUseCase } from "../../application/use-cases/get-wager-transaction.use-case";
import { Money, type MoneyProps } from "../../domain/money";
import type { WagerTransaction } from "../../domain/wager-transaction";

// Kinds cuja referencia e obrigatoria - checado aqui, na borda do payload, para que a ausencia
// vire 400 INVALID_PAYLOAD (zod) e nunca alcance WagerTransaction.create(), cujo throw
// equivalente e so uma rede de seguranca interna (nao estende DomainError).
const KINDS_REQUIRING_REFERENCE: ReadonlySet<string> = new Set(["REFUND", "ROLLBACK"]);

const processWagerTransactionBodySchema = z
  .object({
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
  })
  .superRefine((data, ctx) => {
    if (KINDS_REQUIRING_REFERENCE.has(data.kind) && !data.referenceExternalTransactionId) {
      ctx.addIssue({
        code: "custom",
        path: ["referenceExternalTransactionId"],
        message: `referenceExternalTransactionId is required for kind "${data.kind}"`,
      });
    }
  });

interface ProcessWagerTransactionResponseBody {
  transactionId: string;
  status: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

const transactionIdParamSchema = z.string().uuid();

interface GetWagerTransactionResponseBody {
  status: string;
  kind: string;
  money: MoneyProps;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export function toGetResponseBody(transaction: WagerTransaction): GetWagerTransactionResponseBody {
  return {
    status: transaction.status,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.processedAt ? { processedAt: transaction.processedAt } : {}),
  };
}

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

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

    const money = Money.from(parsed.data.money);

    const result: ProcessWagerTransactionResult = await this.processWagerTransactionUseCase.execute({
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

    res.status(this.statusFor(result)).json(this.toResponseBody(result));
  }

  @Get(":transactionId")
  async get(@Param("transactionId") transactionId: string): Promise<GetWagerTransactionResponseBody> {
    const parsed = transactionIdParamSchema.safeParse(transactionId);
    if (!parsed.success) {
      throw new BadRequestException("transactionId: must be a valid UUID");
    }

    const transaction = await this.getWagerTransactionUseCase.execute(transactionId);
    return toGetResponseBody(transaction);
  }

  private statusFor(result: ProcessWagerTransactionResult): number {
    if (result.status === "REJECTED") {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }
    // PENDING_REFERENCE nao e replay nem rejeicao - a referencia obrigatoria ainda pode se
    // resolver depois (worker de reprocessamento), entao o status HTTP marca "aceito, mas nao
    // concluido" mesmo ao repetir a mesma Idempotency-Key enquanto a transacao permanece pendente.
    if (result.status === "PENDING_REFERENCE") {
      return HttpStatus.ACCEPTED;
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
}
