import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SqsModule } from "../../infrastructure/messaging/sqs-client.module";
import { HealthController } from "./health.controller";
import { HealthReadyController } from "./health-ready.controller";

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [HealthController, HealthReadyController],
})
export class HealthModule {}
