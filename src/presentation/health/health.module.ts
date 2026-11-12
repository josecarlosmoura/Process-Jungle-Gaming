import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { HealthController } from "./health.controller";
import { HealthReadyController } from "./health-ready.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, HealthReadyController],
})
export class HealthModule {}
