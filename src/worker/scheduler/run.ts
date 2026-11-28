import { schedulerState } from "../../../db/schema";
import { systemClock, type Clock } from "../core/clock";
import { cronHooksFor } from "../core/cron";
import type { Db } from "../core/db/client";
import { createLogger, consoleSink } from "../ops/logging";
import { readLastTick, recordTick } from "../ops/health";
import { alertStaleTick } from "./alert";
import "./hooks";
import { pingHealthcheck } from "./ping";
import { tickHooks, type TickContext } from "./registry";
import {
  LAST_RUN_KEY,
  LOCK_KEY,
  NEXT_DUE_KEY,
  isTickStale,
  readLastRun,
  readNextDue,
} from "./schedule";

const HOUR_MS = 3_600_000;
/** Maintenance hooks run at least this often even when nothing is due. */
const MAINTENANCE_EVERY_MS = 24 * HOUR_MS;
const DEFAULT_BOUND_MS = 30_000;
/** KV expirationTtl must be at least 60 s. The lock outlives the bound, so a dead run frees itself. */
const MIN_LOCK_TTL_S = 60;

export interface RunRecord {
  at: Date;
  durationMs: number;
  error: string | null;
}

/** Everything with a side effect outside KV, injectable for tests. */
export interface SchedulerDeps {
  clock: Clock;
  /** Wall-clock bound for each hook; a slower hook is recorded as failed. */
  boundMs: number;
  openDb: (env: Cloudflare.Env) => Promise<Db>;
  closeDb: (db: Db) => Promise<void>;
  ping: (env: Cloudflare.Env, outcome: "success" | "fail") => Promise<void>;
  recordRun: (db: Db, run: RunRecord) => Promise<void>;
  alertStale: (db: Db, info: { lastTickAt: number; now: Date }) => Promise<void>;
}

export interface RunSummary {
  outcome: "overlap" | "idle" | "ran";
  failures: Array<{ hook: string; message: string }>;
}

const defaults: SchedulerDeps = {
  clock: systemClock,
  boundMs: DEFAULT_BOUND_MS,
  // Dynamic import keeps `pg` out of the static graph, like context.ts (docs/ops/db.md).
  openDb: async (env) =>
    (await import("../core/db/client")).createDb(env.HYPERDRIVE.connectionString),
  closeDb: (db) => (db as unknown as { $client: { end(): Promise<void> } }).$client.end(),
  ping: (env, outcome) => {
    // HEALTHCHECK_PING_URL is an optional secret, so it is not in the generated Env type.
    const url: unknown = Reflect.get(env, "HEALTHCHECK_PING_URL");
    return pingHealthcheck(typeof url === "string" ? { HEALTHCHECK_PING_URL: url } : {}, outcome);
  },
  recordRun,
  alertStale: alertStaleTick,
};

/** Writes the singleton `scheduler_state` row (PLAN §5.1). */
export async function recordRun(db: Db, run: RunRecord): Promise<void> {
  const values = {
    lastTickAt: run.at,
    lastTickDurationMs: run.durationMs,
    lastError: run.error,
  };
  await db
    .insert(schedulerState)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: schedulerState.id, set: values });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects with a time-bound error when `work` takes longer than `ms`. */
function withinBound(work: Promise<void>, ms: number): Promise<void> {
  const handle: { id?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<never>((_, reject) => {
    handle.id = setTimeout(() => {
      reject(new Error(`exceeded time bound of ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (handle.id !== undefined) clearTimeout(handle.id);
  });
}

/**
 * One scheduler tick (S6.4, PLAN §11.1):
 * 1. take the KV overlap lock; a second run while it is held is a no-op;
 * 2. record the tick (so `/healthz/ready` sees the cron alive) and raise the
 *    `admin_tasks` alert if the previous tick was stale;
 * 3. read `next_due_at` from KV; when nothing is due (and the daily maintenance is not
 *    owed) return without opening the database;
 * 4. otherwise run every hook within the time bound. A failing hook is recorded and
 *    the others still run; a failed run stays due, so the next tick retries it. A
 *    missed run needs no special case: one run serves everything that is due.
 */
export async function runTick(
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: Cloudflare.Env,
  overrides: Partial<SchedulerDeps> = {},
): Promise<RunSummary & { firstError?: unknown }> {
  const deps = { ...defaults, ...overrides };
  const { clock, boundMs } = deps;
  const runId = crypto.randomUUID();
  const log = createLogger({
    requestId: runId,
    sink: consoleSink,
    now: () => clock.now().getTime(),
  });

  const holder = await env.KV.get(LOCK_KEY);
  if (holder !== null) {
    log.info("scheduler.overlap", { holder });
    return { outcome: "overlap", failures: [] };
  }
  const lockTtl = Math.max(MIN_LOCK_TTL_S, Math.ceil(boundMs / 1000) + 30);
  await env.KV.put(LOCK_KEY, runId, { expirationTtl: lockTtl });
  // KV is not atomic: a run that raced us may have overwritten the lock. Only one wins.
  if ((await env.KV.get(LOCK_KEY)) !== runId) {
    return { outcome: "overlap", failures: [] };
  }

  const opened: { db?: Db; promise?: Promise<Db> } = {};
  const getDb = (): Promise<Db> => {
    opened.promise ??= deps.openDb(env).then((db) => {
      opened.db = db;
      return db;
    });
    return opened.promise;
  };
  const startedAt = clock.now();

  try {
    const lastTick = await readLastTick(env.KV);
    await recordTick(env.KV, clock);

    if (lastTick !== null && isTickStale(lastTick, startedAt.getTime())) {
      try {
        await deps.alertStale(await getDb(), { lastTickAt: lastTick, now: startedAt });
      } catch (error) {
        log.error("scheduler.alert_failed", { message: messageOf(error) });
      }
    }

    const [nextDue, lastRun] = await Promise.all([readNextDue(env.KV), readLastRun(env.KV)]);
    const due = nextDue !== null && nextDue <= startedAt.getTime();
    const maintenanceOwed =
      lastRun === null || startedAt.getTime() - lastRun >= MAINTENANCE_EVERY_MS;
    if (!due && !maintenanceOwed) {
      await deps.ping(env, "success");
      return { outcome: "idle", failures: [] };
    }

    const scheduledAt = new Date(controller.scheduledTime);
    const named: Array<[string, () => Promise<void>]> = [
      ...cronHooksFor(controller.cron).map((hook, i): [string, () => Promise<void>] => [
        `cron#${String(i)}`,
        () => hook({ scheduledAt, cron: controller.cron }),
      ]),
      ...[...tickHooks()].map(([name, hook]): [string, () => Promise<void>] => [
        name,
        async () => {
          const ctx: TickContext = {
            db: await getDb(),
            clock,
            now: startedAt,
            cron: controller.cron,
            kv: env.KV,
          };
          await hook(ctx);
        },
      ]),
    ];

    const results = await Promise.allSettled(
      named.map(([, run]) => withinBound(Promise.resolve().then(run), boundMs)),
    );
    const failures: RunSummary["failures"] = [];
    let firstError: unknown;
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failures.push({ hook: named[i]?.[0] ?? "?", message: messageOf(result.reason) });
        firstError ??= result.reason;
      }
    });
    const error = failures.map((f) => `${f.hook}: ${f.message}`).join("; ") || null;

    try {
      await deps.recordRun(await getDb(), {
        at: startedAt,
        durationMs: clock.now().getTime() - startedAt.getTime(),
        error,
      });
    } catch (recordError) {
      log.error("scheduler.record_failed", { message: messageOf(recordError) });
    }

    if (failures.length === 0) {
      await env.KV.put(LAST_RUN_KEY, String(startedAt.getTime()));
      // Serve what was due. A hook may have scheduled later work; keep that.
      const after = await readNextDue(env.KV);
      if (after !== null && after <= startedAt.getTime()) await env.KV.delete(NEXT_DUE_KEY);
    } else {
      log.error("scheduler.hooks_failed", { failures });
    }
    await deps.ping(env, failures.length === 0 ? "success" : "fail");
    return { outcome: "ran", failures, firstError };
  } finally {
    try {
      if ((await env.KV.get(LOCK_KEY)) === runId) await env.KV.delete(LOCK_KEY);
    } catch {
      // Lock has a short TTL; never skip closeDb if KV cleanup fails.
    }
    if (opened.db) {
      try {
        await deps.closeDb(opened.db);
      } catch {
        // The connection is gone with the isolate anyway.
      }
    }
  }
}

/**
 * Entry point for `scheduled()`. Runs the tick, then rethrows the first hook failure
 * so Cloudflare marks the invocation as failed (after every hook has run).
 */
export async function runScheduled(
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  env: Cloudflare.Env,
  overrides: Partial<SchedulerDeps> = {},
): Promise<void> {
  const summary = await runTick(controller, env, overrides);
  if (summary.failures.length > 0) throw summary.firstError;
}
