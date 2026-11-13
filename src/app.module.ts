import { Module } from "@nestjs/common";
import { AppConfigModule } from "./infrastructure/config/app-config.module";
import { HealthModule } from "./presentation/health/health.module";
import { WalletsModule } from "./presentation/wallets/wallets.module";

@Module({
  imports: [AppConfigModule, HealthModule, WalletsModule],
})
export class AppModule {}
