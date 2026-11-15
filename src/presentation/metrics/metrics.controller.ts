import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { MetricsService } from "../../infrastructure/observability/metrics.service";

// Sem guard, deliberadamente, para sempre (plan.md Landing door 2) - mesmo nivel de
// GET /health/live e GET /health/ready: servidores Prometheus/orquestradores nao carregam
// credenciais de negocio para fazer scrape.
@Controller("metrics")
export class MetricsController {
  @Get()
  async get(@Res() res: Response): Promise<void> {
    const body = await MetricsService.getMetricsText();
    res.set("Content-Type", MetricsService.getContentType());
    res.set("Cache-Control", "no-store");
    res.send(body);
  }
}
