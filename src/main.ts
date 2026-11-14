import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AppConfigService } from "./infrastructure/config/app-config.service";
import { correlationIdMiddleware } from "./infrastructure/observability/correlation-id.middleware";
import { PinoLoggerService } from "./infrastructure/observability/pino-logger.service";

async function bootstrap(): Promise<void> {
  // bufferLogs mantem os logs de inicializacao (antes de useLogger rodar) em buffer e os
  // libera depois, via pino tambem - sem isso, qualquer log emitido durante a construcao dos
  // modulos (ex.: nos factories dos providers) escaparia como texto livre do ConsoleLogger padrao.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new PinoLoggerService());
  app.use(correlationIdMiddleware);
  // Sem isto, nenhum OnModuleDestroy roda em SIGTERM - nem o do WagerTransactionSqsConsumer
  // (T210) nem o ja existente do OutboxPublisherScheduler (T209).
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  // Fallback de ultimo recurso: o bootstrap falhou antes (ou durante) a construcao do proprio
  // logger da aplicacao, entao nao ha garantia de que PinoLoggerService exista - ainda assim
  // emite uma linha JSON (nunca texto livre), para nunca escapar da regra "todo log e JSON".
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: "fatal", timestamp: new Date().toISOString(), msg: message }));
  process.exit(1);
});
