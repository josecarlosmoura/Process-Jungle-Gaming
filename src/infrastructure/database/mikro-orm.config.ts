import { PostgreSqlDriver, type Options } from "@mikro-orm/postgresql";
import { validateEnv } from "../config/env.schema";

export interface DatabaseConnectionEnv {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

export function buildMikroOrmOptions(env: DatabaseConnectionEnv): Options {
  return {
    driver: PostgreSqlDriver,
    host: env.dbHost,
    port: env.dbPort,
    user: env.dbUser,
    password: env.dbPassword,
    dbName: env.dbName,
    // sem isto, MikroORM.init() abre a conexao TCP na propria composicao do modulo Nest -
    // quebraria qualquer Test.createTestingModule({ imports: [AppModule] }).compile() sem
    // Postgres no ar. A conexao real so e aberta lazily na primeira query (ensureConnection()),
    // que e exatamente o que PostgresHealthIndicator exercita.
    connect: false,
    // forcado para nao depender da heuristica de deteccao de ts-node do MikroORM,
    // que nao reconhece o runtime do Bun - sem isto a CLI procuraria migrations
    // compiladas em dist/, que nao existem no fluxo local (bun direto sobre o src/ts)
    preferTs: true,
    entities: ["./dist/**/*.entity.js"],
    entitiesTs: ["./src/**/*.entity.ts"],
    // nenhuma entidade de dominio existe ainda (chega a partir de T102) - sem isto, o
    // MikroORM trata "zero entidades descobertas" como configuracao invalida e lanca erro
    discovery: { warnWhenNoEntities: false },
    migrations: {
      path: "./dist/infrastructure/database/migrations",
      pathTs: "./src/infrastructure/database/migrations",
    },
  };
}

export function resolveCliMikroOrmOptions(processEnv: NodeJS.ProcessEnv = process.env): Options {
  const env = validateEnv(processEnv);
  return buildMikroOrmOptions({
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    dbName: env.DB_NAME,
  });
}
