/**
 * Scheduler constants and KV state (PLAN §11.1, §11.3; DECISIONS 2026-11-24, S6.4).
 *
 * Both Cron Triggers are in UTC. Stockholm is UTC+1 in winter and UTC+2 in summer, so
 * the 07-23 local window is UTC 05-21 in summer and 06-22 in winter. The frequent
 * trigger covers the union (UTC 05-22) and the hourly trigger the rest, so every UTC
 * hour belongs to exactly one trigger. Running one extra hour per season is free:
 * the `next_due_at` gate keeps idle ticks off Neon.
 */
export const CRON_FREQUENT = "*/10 5-22 * * *";
export const CRON_HOURLY = "0 0-4,23 * * *";

/** KV: epoch ms of the earliest work that is due. Absent means nothing is scheduled. */
export const NEXT_DUE_KEY = "scheduler:next_due_at";
/** KV: epoch ms of the last run that completed without a failing hook. */
export const LAST_RUN_KEY = "scheduler:last_run_at";
/** KV: overlap lock; the value is the id of the run that holds it. */
export const LOCK_KEY = "scheduler:lock";

const MINUTE_MS = 60_000;
const FREQUENT_MS = 10 * MINUTE_MS;
const HOURLY_MS = 60 * MINUTE_MS;
const STALE_FACTOR = 2;

/** First and last UTC hour of the frequent trigger. Keep in step with CRON_FREQUENT. */
const FREQUENT_FROM_UTC = 5;
const FREQUENT_TO_UTC = 22;

/** The cron cadence in effect at `atMs`. */
export function cronIntervalMs(atMs: number): number {
  const hour = new Date(atMs).getUTCHours();
  return hour >= FREQUENT_FROM_UTC && hour <= FREQUENT_TO_UTC ? FREQUENT_MS : HOURLY_MS;
}

/**
 * True when no tick arrived for more than two cron intervals. The interval is the
 * slower of the cadence at the previous tick and now, so the hourly-to-frequent
 * handover (04:00 then 05:00 UTC) is not reported as an outage. No tick is stale.
 */
export function isTickStale(lastTickMs: number | null, nowMs: number): boolean {
  if (lastTickMs === null) return true;
  const interval = Math.max(cronIntervalMs(lastTickMs), cronIntervalMs(nowMs));
  return nowMs - lastTickMs > STALE_FACTOR * interval;
}

async function readEpoch(kv: KVNamespace, key: string): Promise<number | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export const readNextDue = (kv: KVNamespace): Promise<number | null> => readEpoch(kv, NEXT_DUE_KEY);
export const readLastRun = (kv: KVNamespace): Promise<number | null> => readEpoch(kv, LAST_RUN_KEY);

/**
 * Tells the scheduler that work is due at `at`. Feature stories call this when they
 * create something time-bound (an event deadline, a reminder). The earliest time wins.
 * Not atomic across Workers, which is fine: a lost write only delays work to the next
 * daily maintenance run, and close-on-read covers event closing (PLAN §6).
 */
export async function markDue(kv: KVNamespace, at: Date): Promise<void> {
  const current = await readNextDue(kv);
  if (current === null || at.getTime() < current) {
    await kv.put(NEXT_DUE_KEY, String(at.getTime()));
  }
}
