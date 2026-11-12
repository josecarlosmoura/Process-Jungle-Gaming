import { Injectable } from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS le o tipo do parametro do construtor em tempo de execucao (metadata de DI) - import type apagaria a classe e quebraria a injecao
import { EntityManager } from "@mikro-orm/postgresql";

export const DEFAULT_TIMEOUT_MS = 2000;

@Injectable()
export class PostgresHealthIndicator {
  constructor(private readonly em: EntityManager) {}

  async check(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("postgres health check timed out")), timeoutMs);
    });

    try {
      await Promise.race([this.em.getConnection().execute("SELECT 1"), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
