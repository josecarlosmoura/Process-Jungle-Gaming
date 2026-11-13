import { Module } from "@nestjs/common";
import { AppConfigModule } from "./infrastructure/config/app-config.module";
import { HealthModule } from "./presentation/health/health.module";
import { WalletsModule } from "./presentation/wallets/wallets.module";
import { WageringModule } from "./presentation/wagering/wagering.module";

@Module({
  imports: [AppConfigModule, HealthModule, WalletsModule, WageringModule],
})
export class AppModule {}
