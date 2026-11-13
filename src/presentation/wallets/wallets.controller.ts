import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { GetWalletUseCase } from "../../application/use-cases/get-wallet.use-case";
import { InvalidMoneyAmountError, Money } from "../../domain/money";
import { WalletAlreadyExistsError, WalletNotFoundError } from "../../domain/wallet";
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

    const initialBalance = this.parseMoney(parsed.data.initialBalance);

    try {
      const wallet = await this.createWalletUseCase.execute({
        playerId: parsed.data.playerId,
        initialBalance,
      });
      return toResponseBody(wallet);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string): Promise<WalletResponseBody> {
    const parsedWalletId = walletIdParamSchema.safeParse(walletId);
    if (!parsedWalletId.success) {
      throw new BadRequestException(`walletId: must be a valid UUID`);
    }

    try {
      const wallet = await this.getWalletUseCase.execute(walletId);
      return toResponseBody(wallet);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
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
