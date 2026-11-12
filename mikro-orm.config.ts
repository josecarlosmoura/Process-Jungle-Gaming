import { config } from "dotenv";
import { resolveCliMikroOrmOptions } from "./src/infrastructure/database/mikro-orm.config";

// a CLI do MikroORM roda fora do bootstrap do Nest (que carrega o .env via
// ConfigModule.forRoot()) e, neste projeto, roda sob Node (nao Bun) por tras do
// binario mikro-orm no Windows - sem isto, process.env nao teria as variaveis do .env
config();

export default resolveCliMikroOrmOptions();
