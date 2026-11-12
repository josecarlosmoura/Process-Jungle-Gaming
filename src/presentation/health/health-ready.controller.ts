import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { PostgresHealthIndicator } from "../../infrastructure/database/postgres-health.indicator";

@Controller("health")
export class HealthReadyController {
  constructor(private readonly postgresHealthIndicator: PostgresHealthIndicator) {}

  @Get("ready")
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<{ status: "ok"; postgres: "up" }> {
    const postgresUp = await this.postgresHealthIndicator.check();

    if (!postgresUp) {
      throw new ServiceUnavailableException({ status: "error", postgres: "down" });
    }

    return { status: "ok", postgres: "up" };
  }
}
