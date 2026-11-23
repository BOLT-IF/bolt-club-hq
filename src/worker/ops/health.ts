import type { Context } from "hono";

import type { Clock } from "./clock";

/** KV key holding the epoch-ms time of the most recent cron tick (PLAN §11.2 scheduler state). */
export const LAST_TICK_KEY = "ops:last_tick_at";

const MINUTE_MS = 60_000;
// The every-10-minutes trigger runs at 05:00–21:59 UTC (PLAN §11.1, DECISIONS S0.1).
const FREQUENT_CRON_MS = 10 * MINUTE_MS;
const HOURLY_CRON_MS = 60 * MINUTE_MS;
/** Stale means no tick for more than two cron intervals. */
const STALE_FACTOR = 2;

export type DbStatus = "ok" | "error" | "unknown";

export interface HealthDeps {
  clock: Clock;
  probeDb: () => Promise<DbStatus>;
  lastTickAt: () => Promise<number | null>;
  queueDepth: () => Promise<number | null>;
}

/** The cron cadence in effect at `nowMs` (UTC hour 05–21 is the frequent window). */
export function cronIntervalMs(nowMs: number): number {
  const hour = new Date(nowMs).getUTCHours();
  return hour >= 5 && hour <= 21 ? FREQUENT_CRON_MS : HOURLY_CRON_MS;
}

export function isTickStale(lastTick: number | null, nowMs: number): boolean {
  if (lastTick === null) {
    return true;
  }
  return nowMs - lastTick > STALE_FACTOR * cronIntervalMs(nowMs);
}

/** Builds the `/healthz` handler from injected probes. Returns 503 when the DB or the tick is unhealthy. */
export function createHealthHandler(deps: HealthDeps) {
  return async (c: Context): Promise<Response> => {
    const now = deps.clock.now();
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
  await kv.put(LAST_TICK_KEY, String(clock.now()));
}
