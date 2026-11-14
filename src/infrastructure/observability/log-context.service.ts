import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

// Metodos estaticos de proposito - AsyncLocalStorage ja e por natureza um singleton de processo;
// uma classe injetavel via Nest DI so acrescentaria ceremonia sem nenhum beneficio real (nenhuma
// configuracao, nenhuma variacao por modulo), e obrigaria todo modulo que loga (4+ hoje) a
// importar e registrar mais um provider so para isto.
export class LogContextService {
  static run<T>(initial: LogContext, callback: () => T): T {
    return storage.run({ ...initial }, callback);
  }

  // Muta o mesmo objeto que storage.run() guardou - visivel para todo o resto da cadeia
  // assincrona daquela mesma operacao (controller -> use case -> repositorio), nunca cria um novo
  // escopo. Chamado fora de um run() ativo e um no-op silencioso (ex.: um teste de unidade que
  // chama o use case direto, sem borda) - nunca lanca.
  static set(patch: Partial<LogContext>): void {
    const store = storage.getStore();
    if (store) {
      Object.assign(store, patch);
    }
  }

  static get(): LogContext {
    return storage.getStore() ?? {};
  }
}
