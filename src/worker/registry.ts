import { Hono } from "hono";

import type { AppEnv } from "./types";

/**
 * Backend route registry. Every `src/worker/<area>/routes.ts` default-exports a
 * Hono sub-app with paths relative to `/api/v1` (for example `/probe`).
 * New areas are picked up automatically; nothing is wired by hand.
 */
const routeModules = import.meta.glob<{ default: Hono<AppEnv> }>("./*/routes.ts", {
  eager: true,
});

export const API_BASE_PATH = "/api/v1";

export function mountBackendRoutes(app: Hono<AppEnv>): void {
  for (const mod of Object.values(routeModules)) {
    app.route(API_BASE_PATH, mod.default);
  }
}

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

export function registeredBackendRoutes(): RegisteredRoute[] {
  const app = new Hono<AppEnv>();
  mountBackendRoutes(app);
  return app.routes.map((route) => ({ method: route.method, path: route.path }));
}
