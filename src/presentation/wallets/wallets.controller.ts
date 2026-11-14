import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWalletLedgerUseCase, type GetWalletLedgerResult } from "../../application/use-cases/get-wallet-ledger.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { ReconcileWalletUseCase, type ReconcileWalletResult } from "../../application/use-cases/reconcile-wallet.use-case";
import { Money, type MoneyProps } from "../../domain/money";
import type { Wallet } from "../../domain/wallet";

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

const createWalletBodySchema = z.object({
  playerId: z.string().min(1),
  initialBalance: z.object({
    amount: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter uppercase currency code"),
  }),
});

const walletIdParamSchema = z.string().uuid();

interface WalletResponseBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

function toResponseBody(wallet: Wallet): WalletResponseBody {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

interface LedgerEntryResponseBody {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

interface GetWalletLedgerResponseBody {
  entries: LedgerEntryResponseBody[];
  nextCursor?: string;
}

export function parseLedgerLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new BadRequestException("limit: must be a positive integer");
  }
  return Math.min(Number(raw), MAX_LEDGER_LIMIT);
}

function toLedgerResponseBody(result: GetWalletLedgerResult): GetWalletLedgerResponseBody {
  return {
    entries: result.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      createdAt: entry.createdAt,
    })),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

interface ReconciliationResponseBody {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

function toReconciliationResponseBody(result: ReconcileWalletResult): ReconciliationResponseBody {
  return {
    walletId: result.walletId,
    storedBalance: result.storedBalance.toJSON(),
    calculatedBalance: result.calculatedBalance.toJSON(),
    difference: result.difference.toJSON(),
    consistent: result.consistent,
    checkedEntries: result.checkedEntries,
  };
}

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletResponseBody> {
    const parsed = createWalletBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    }

    const initialBalance = Money.from(parsed.data.initialBalance);

    const wallet = await this.createWalletUseCase.execute({
      playerId: parsed.data.playerId,
      initialBalance,
    });
    return toResponseBody(wallet);
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string): Promise<WalletResponseBody> {
    const parsedWalletId = walletIdParamSchema.safeParse(walletId);
    if (!parsedWalletId.success) {
      throw new BadRequestException(`walletId: must be a valid UUID`);
    }

    const wallet = await this.getWalletUseCase.execute(walletId);
    return toResponseBody(wallet);
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limitRaw: string | undefined,
  ): Promise<GetWalletLedgerResponseBody> {
    const parsedWalletId = walletIdParamSchema.safeParse(walletId);
    if (!parsedWalletId.success) {
      throw new BadRequestException(`walletId: must be a valid UUID`);
    }
    const limit = parseLedgerLimit(limitRaw);

    const result = await this.getWalletLedgerUseCase.execute({ walletId, cursor, limit });
    return toLedgerResponseBody(result);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param("walletId") walletId: string): Promise<ReconciliationResponseBody> {
    const parsedWalletId = walletIdParamSchema.safeParse(walletId);
    if (!parsedWalletId.success) {
      throw new BadRequestException(`walletId: must be a valid UUID`);
    }

    const result = await this.reconcileWalletUseCase.execute(walletId);
    return toReconciliationResponseBody(result);
  }
}
