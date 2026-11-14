import { Injectable } from "@nestjs/common";

// Contador em memoria por processo - ponto de extensao para T306 formalizar a exposicao real de
// metricas (ex.: /metrics Prometheus); aqui so precisa existir e incrementar corretamente (RN-55
// trata "logada" e "contabilizada em metrica" como duas acoes distintas, nao uma so).
@Injectable()
export class ReconciliationMetrics {
  private _divergenceCount = 0;

  recordDivergence(): void {
    this._divergenceCount += 1;
  }

  get divergenceCount(): number {
    return this._divergenceCount;
  }
}
