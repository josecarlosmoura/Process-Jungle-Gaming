import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { z } from "zod";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { Money } from "../../domain/money";
import type { Wallet } from "../../domain/wallet";

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

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
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
}
