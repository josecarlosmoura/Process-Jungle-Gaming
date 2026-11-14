import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { LogContextService } from "./log-context.service";

export const CORRELATION_ID_HEADER = "x-correlation-id";

// Express normaliza nomes de header para minusculo - req.headers[CORRELATION_ID_HEADER] casa com
// "X-Correlation-Id" (ou qualquer variacao de caixa) enviado pelo cliente.
export function correlationIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers[CORRELATION_ID_HEADER];
  const correlationId = (Array.isArray(header) ? header[0] : header) || randomUUID();
  // next() roda dentro do callback de run() - toda a cadeia assincrona que ele dispara (guards,
  // interceptors, o controller, o use case) enxerga o mesmo contexto, porque AsyncLocalStorage
  // propaga pela continuacao assincrona, nao so pela chamada sincrona imediata.
  LogContextService.run({ correlationId }, next);
}
