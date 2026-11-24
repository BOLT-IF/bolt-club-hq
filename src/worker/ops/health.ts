import type { Context } from "hono";

import type { Clock } from "../core/clock";
import { cronIntervalMs, isTickStale } from "../scheduler/schedule";

export { cronIntervalMs, isTickStale };

/** KV key holding the epoch-ms time of the most recent cron tick (PLAN §11.2 scheduler state). */
export const LAST_TICK_KEY = "ops:last_tick_at";

export type DbStatus = "ok" | "error" | "unknown";

export interface HealthDeps {
  clock: Clock;
  probeDb: () => Promise<DbStatus>;
  lastTickAt: () => Promise<number | null>;
  queueDepth: () => Promise<number | null>;
}

/** Builds the `/healthz` handler from injected probes. Returns 503 when the DB or the tick is unhealthy. */
export function createHealthHandler(deps: HealthDeps) {
  return async (c: Context): Promise<Response> => {
    const now = deps.clock.now().getTime();
    const [db, lastTick, queue] = await Promise.all([
      deps.probeDb(),
      deps.lastTickAt(),
      deps.queueDepth(),
    ]);
    const stale = isTickStale(lastTick, now);
    const healthy = db !== "error" && !stale;
    return c.json(
      {
        status: healthy ? "ok" : "degraded",
        db: { status: db },
        tick: {
          last_tick_at: lastTick === null ? null : new Date(lastTick).toISOString(),
          stale,
          interval_ms: cronIntervalMs(now),
        },
        queue: { depth: queue },
      },
      healthy ? 200 : 503,
    );
  };
}

/** Reads the last tick time from KV. Returns null when none has been recorded. */
export async function readLastTick(kv: KVNamespace): Promise<number | null> {
  const raw = await kv.get(LAST_TICK_KEY);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Records a cron tick. The scheduled() hook calls this on every run. */
export async function recordTick(kv: KVNamespace, clock: Clock): Promise<void> {
  await kv.put(LAST_TICK_KEY, String(clock.now().getTime()));
}
