import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { PostgresHealthIndicator } from "../../infrastructure/database/postgres-health.indicator";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { SqsHealthIndicator } from "../../infrastructure/messaging/sqs-health.indicator";

type DependencyStatus = "up" | "down";

@Controller("health")
export class HealthReadyController {
  constructor(
    private readonly postgresHealthIndicator: PostgresHealthIndicator,
    private readonly sqsHealthIndicator: SqsHealthIndicator,
  ) {}

  @Get("ready")
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<{ status: "ok"; postgres: "up"; sqs: "up" }> {
    const [postgresUp, sqsUp] = await Promise.all([
      this.postgresHealthIndicator.check(),
      this.sqsHealthIndicator.check(),
    ]);

    const postgres: DependencyStatus = postgresUp ? "up" : "down";
    const sqs: DependencyStatus = sqsUp ? "up" : "down";

    if (!postgresUp || !sqsUp) {
      throw new ServiceUnavailableException({ status: "error", postgres, sqs });
    }

    return { status: "ok", postgres: "up", sqs: "up" };
  }
}
