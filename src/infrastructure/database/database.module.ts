import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { AppConfigModule } from "../config/app-config.module";
import { AppConfigService } from "../config/app-config.service";
import { buildMikroOrmOptions } from "./mikro-orm.config";
import { PostgresHealthIndicator } from "./postgres-health.indicator";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        buildMikroOrmOptions({
          dbHost: config.dbHost,
          dbPort: config.dbPort,
          dbUser: config.dbUser,
          dbPassword: config.dbPassword,
          dbName: config.dbName,
        }),
    }),
  ],
  providers: [PostgresHealthIndicator],
  exports: [PostgresHealthIndicator],
})
export class DatabaseModule {}
