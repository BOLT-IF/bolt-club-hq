import { Hono } from "hono";

import { systemClock } from "./clock";
import { createHealthHandler, readLastTick, type DbStatus } from "./health";
import { requestIdMiddleware, type OpsEnv } from "./logging";

/**
 * Ops bindings. KV holds `ops:last_tick_at`. The DB probe and queue depth are
 * injected: S0.2 supplies the database client and the outbox queue, and until
 * then both report "unknown" or null without degrading health.
 */
export interface OpsBindings {
  KV: KVNamespace;
}

export interface OpsProbes {
  probeDb?: () => Promise<DbStatus>;
  queueDepth?: () => Promise<number | null>;
}

/** Builds the `/healthz` app. Mount it at the Worker root, outside `/api/v1`. */
export function createOpsApp(probes: OpsProbes = {}): Hono<OpsEnv & { Bindings: OpsBindings }> {
  const app = new Hono<OpsEnv & { Bindings: OpsBindings }>();
  app.use("*", requestIdMiddleware({ now: () => systemClock.now() }));
  app.get("/healthz", (c) =>
    createHealthHandler({
      clock: systemClock,
      probeDb: probes.probeDb ?? (() => Promise.resolve("unknown")),
      lastTickAt: () => readLastTick(c.env.KV),
      queueDepth: probes.queueDepth ?? (() => Promise.resolve(null)),
    })(c),
  );
  return app;
}
