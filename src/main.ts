import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AppConfigService } from "./infrastructure/config/app-config.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Sem isto, nenhum OnModuleDestroy roda em SIGTERM - nem o do WagerTransactionSqsConsumer
  // (T210) nem o ja existente do OutboxPublisherScheduler (T209).
  app.enableShutdownHooks();
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
