import { Controller, Get, HttpCode } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get("live")
  @HttpCode(200)
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}
