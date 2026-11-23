import { Hono } from "hono";

import { systemClock } from "../core/clock";
import { createHealthHandler, readLastTick, type DbStatus } from "./health";
import type { OpsEnv } from "./logging";

/**
 * Ops bindings. KV holds `ops:last_tick_at`. The DB probe and queue depth are
 * injected; until a story supplies them they report "unknown" or null, which
 * does not degrade readiness.
 */
export interface OpsBindings {
  KV: KVNamespace;
}

export interface OpsProbes {
  probeDb?: () => Promise<DbStatus>;
  queueDepth?: () => Promise<number | null>;
}

/**
 * Ops routes, mounted at the Worker root (outside `/api/v1`):
 * - `/healthz`: liveness. 200 whenever the Worker runs. Used by the deploy smoke
 *   test and Playwright's startup wait, which run before any cron tick exists.
 * - `/healthz/ready`: readiness. The strict S0.7 verdict (DB, cron tick, queue),
 *   503 when degraded. For monitoring and alerts.
 * Request IDs are added by the parent app (`src/worker/app.ts`), for every route.
 */
export function createOpsApp(probes: OpsProbes = {}): Hono<OpsEnv & { Bindings: OpsBindings }> {
  const app = new Hono<OpsEnv & { Bindings: OpsBindings }>();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/healthz/ready", (c) =>
    createHealthHandler({
      clock: systemClock,
      probeDb: probes.probeDb ?? (() => Promise.resolve("unknown")),
      lastTickAt: () => readLastTick(c.env.KV),
      queueDepth: probes.queueDepth ?? (() => Promise.resolve(null)),
    })(c),
  );
  return app;
}
