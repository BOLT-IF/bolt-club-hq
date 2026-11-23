import { Hono } from "hono";

import { mountBackendRoutes } from "./registry";
import type { AppEnv } from "./types";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  mountBackendRoutes(app);
  return app;
}
