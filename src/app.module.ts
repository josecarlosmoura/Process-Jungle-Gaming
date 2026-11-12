import { Module } from "@nestjs/common";
import { AppConfigModule } from "./infrastructure/config/app-config.module";
import { HealthModule } from "./presentation/health/health.module";

@Module({
  imports: [AppConfigModule, HealthModule],
})
export class AppModule {}
