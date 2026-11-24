import { Hono } from "hono";

import { originGuard } from "./auth/origin";
import { systemClock } from "./core/clock";
import { createOpsApp } from "./ops/app";
import { requestIdMiddleware } from "./ops/logging";
import { mountBackendRoutes } from "./registry";
import type { AppEnv } from "./types";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Every request (ops and /api/v1) gets a request id and one structured log line (S0.7).
  app.use("*", requestIdMiddleware({ now: () => systemClock.now().getTime() }));
  app.route("/", createOpsApp());
  app.use("/api/v1/*", originGuard());
  mountBackendRoutes(app);
  return app;
}
