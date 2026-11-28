import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../core/db/client";
import { FixedClock } from "../core/clock";
import { registerCronHook, resetCronHooks } from "../core/cron";
import { LAST_TICK_KEY } from "../ops/health";
import { resetTickHooks, registerTickHook } from "./registry";
import { CRON_FREQUENT, LAST_RUN_KEY, LOCK_KEY, NEXT_DUE_KEY } from "./schedule";
import { runScheduled, runTick, type SchedulerDeps } from "./run";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Monday 2026-12-14 12:00 UTC = 13:00 Stockholm (winter), inside the frequent window.
const NOON = new Date("2026-12-14T12:00:00Z");

interface Harness {
  clock: FixedClock;
  dbOpens: number;
  pings: string[];
  runs: Array<{ error: string | null }>;
  alerts: number[];
  deps: Partial<SchedulerDeps>;
}

function harness(boundMs = 1_000): Harness {
  const h: Harness = {
    clock: new FixedClock(NOON),
    dbOpens: 0,
    pings: [],
    runs: [],
    alerts: [],
    deps: {},
  };
  h.deps = {
    clock: h.clock,
    boundMs,
    openDb: () => {
      h.dbOpens++;
      return Promise.resolve({} as unknown as Db);
    },
    closeDb: () => Promise.resolve(),
    ping: (_env, outcome) => {
      h.pings.push(outcome);
      return Promise.resolve();
    },
    recordRun: (_db, run) => {
      h.runs.push({ error: run.error });
      return Promise.resolve();
    },
    alertStale: (_db, info) => {
      h.alerts.push(info.lastTickAt);
      return Promise.resolve();
    },
  };
  return h;
}

const tick = (h: Harness) =>
  runTick({ cron: CRON_FREQUENT, scheduledTime: h.clock.now().getTime() }, env, h.deps);

async function seedIdle(h: Harness): Promise<void> {
  // A run happened an hour ago and nothing is scheduled: the idle state.
  await env.KV.put(LAST_RUN_KEY, String(h.clock.now().getTime() - HOUR));
  await env.KV.put(LAST_TICK_KEY, String(h.clock.now().getTime() - 10 * MINUTE));
}

beforeEach(() => {
  resetCronHooks();
  resetTickHooks();
});

afterEach(async () => {
  resetCronHooks();
  resetTickHooks();
  await Promise.all(
    [LAST_TICK_KEY, LAST_RUN_KEY, LOCK_KEY, NEXT_DUE_KEY].map((k) => env.KV.delete(k)),
  );
});

describe("scheduled(): next_due_at gate", () => {
  it("never touches the database when nothing is due, but still records the tick and pings", async () => {
    const h = harness();
    await seedIdle(h);
    let ran = 0;
    registerTickHook("probe", () => {
      ran++;
      return Promise.resolve();
    });
    // Due only tomorrow.
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() + 24 * HOUR));

    const summary = await tick(h);

    expect(summary.outcome).toBe("idle");
    expect(h.dbOpens).toBe(0);
    expect(ran).toBe(0);
    expect(await env.KV.get(LAST_TICK_KEY)).toBe(String(NOON.getTime()));
    expect(h.pings).toEqual(["success"]);
  });

  it("runs the hooks when next_due_at has passed, then clears it", async () => {
    const h = harness();
    await seedIdle(h);
    const order: string[] = [];
    registerTickHook("a", () => {
      order.push("a");
      return Promise.resolve();
    });
    registerCronHook(CRON_FREQUENT, () => {
      order.push("core");
      return Promise.resolve();
    });
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    const summary = await tick(h);

    expect(summary.outcome).toBe("ran");
    expect(order.sort()).toEqual(["a", "core"]);
    expect(await env.KV.get(NEXT_DUE_KEY)).toBeNull();
    expect(await env.KV.get(LAST_RUN_KEY)).toBe(String(NOON.getTime()));
    expect(h.runs).toEqual([{ error: null }]);
    expect(h.pings).toEqual(["success"]);
  });

  it("keeps a future next_due_at that a hook set during the run", async () => {
    const h = harness();
    await seedIdle(h);
    const future = NOON.getTime() + 2 * HOUR;
    registerTickHook("sets-due", async () => {
      await env.KV.put(NEXT_DUE_KEY, String(future));
    });
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    await tick(h);

    expect(await env.KV.get(NEXT_DUE_KEY)).toBe(String(future));
  });

  it("still runs maintenance hooks once a day when nothing is ever due (stale idempotency claims)", async () => {
    const h = harness();
    await env.KV.put(LAST_RUN_KEY, String(NOON.getTime() - 25 * HOUR));
    await env.KV.put(LAST_TICK_KEY, String(NOON.getTime() - 10 * MINUTE));
    let ran = 0;
    registerTickHook("maintenance", () => {
      ran++;
      return Promise.resolve();
    });

    await tick(h);

    expect(ran).toBe(1);
  });
});

describe("scheduled(): overlap lock", () => {
  it("is a no-op while another run holds the lock", async () => {
    const h = harness();
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));
    await env.KV.put(LOCK_KEY, "another-run", { expirationTtl: 90 });
    let ran = 0;
    registerTickHook("probe", () => {
      ran++;
      return Promise.resolve();
    });

    const summary = await tick(h);

    expect(summary.outcome).toBe("overlap");
    expect(ran).toBe(0);
    expect(h.dbOpens).toBe(0);
    expect(await env.KV.get(LOCK_KEY)).toBe("another-run");
  });

  it("releases its lock when done, so the next tick runs", async () => {
    const h = harness();
    await seedIdle(h);
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));
    await tick(h);
    expect(await env.KV.get(LOCK_KEY)).toBeNull();
  });
});

describe("scheduled(): missed runs", () => {
  it("catches up exactly once after several missed ticks", async () => {
    const h = harness();
    await seedIdle(h);
    let ran = 0;
    registerTickHook("probe", () => {
      ran++;
      return Promise.resolve();
    });
    // Due three hours ago; the ticks in between never happened.
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - 3 * HOUR));

    await tick(h);
    h.clock.advance(10 * MINUTE);
    await tick(h);
    h.clock.advance(10 * MINUTE);
    await tick(h);

    expect(ran).toBe(1);
  });
});

describe("scheduled(): failing hooks", () => {
  it("records the failure, runs the other hooks, keeps the work due and pings fail", async () => {
    const h = harness();
    await seedIdle(h);
    let otherRan = false;
    registerTickHook("boom", () => Promise.reject(new Error("hook failed")));
    registerTickHook("fine", () => {
      otherRan = true;
      return Promise.resolve();
    });
    const due = NOON.getTime() - MINUTE;
    await env.KV.put(NEXT_DUE_KEY, String(due));

    const summary = await tick(h);

    expect(otherRan).toBe(true);
    expect(summary.failures).toEqual([{ hook: "boom", message: "hook failed" }]);
    expect(h.runs).toEqual([{ error: "boom: hook failed" }]);
    expect(h.pings).toEqual(["fail"]);
    // Not served: the next tick retries.
    expect(await env.KV.get(NEXT_DUE_KEY)).toBe(String(due));
    expect(await env.KV.get(LAST_RUN_KEY)).toBe(String(NOON.getTime() - HOUR));
  });

  it("runScheduled rethrows the first failure after every hook ran", async () => {
    const h = harness();
    await seedIdle(h);
    let otherRan = false;
    registerCronHook(CRON_FREQUENT, () => Promise.reject(new Error("core hook failed")));
    registerTickHook("fine", () => {
      otherRan = true;
      return Promise.resolve();
    });
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    await expect(
      runScheduled({ cron: CRON_FREQUENT, scheduledTime: NOON.getTime() }, env, h.deps),
    ).rejects.toThrow("core hook failed");
    expect(otherRan).toBe(true);
  });

  it("stops waiting for a hook that exceeds the time bound and records a timeout", async () => {
    const h = harness(50);
    await seedIdle(h);
    let otherRan = false;
    registerTickHook("hangs", () => new Promise<void>(() => undefined));
    registerTickHook("fine", () => {
      otherRan = true;
      return Promise.resolve();
    });
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    const summary = await tick(h);

    expect(otherRan).toBe(true);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ hook: "hangs" });
    expect(summary.failures[0]?.message).toMatch(/time bound/);
  });
});

describe("scheduled(): stale tick alert", () => {
  it("raises an alert when the previous tick was more than two intervals ago", async () => {
    const h = harness();
    const last = NOON.getTime() - 3 * HOUR;
    await env.KV.put(LAST_TICK_KEY, String(last));
    await env.KV.put(LAST_RUN_KEY, String(NOON.getTime() - HOUR));

    await tick(h);

    expect(h.alerts).toEqual([last]);
  });

  it("does not alert on a normal tick, on the first ever tick, or on the 04:00 to 05:00 handover", async () => {
    const h = harness();
    await seedIdle(h);
    await tick(h);
    expect(h.alerts).toEqual([]);

    await env.KV.delete(LAST_TICK_KEY);
    await tick(h);
    expect(h.alerts).toEqual([]);

    h.clock.set("2026-12-15T05:00:00Z");
    await env.KV.put(LAST_TICK_KEY, String(Date.parse("2026-12-15T04:00:00Z")));
    await tick(h);
    expect(h.alerts).toEqual([]);
  });

  it("a failing alert does not fail the tick", async () => {
    const h = harness();
    await env.KV.put(LAST_TICK_KEY, String(NOON.getTime() - 3 * HOUR));
    await env.KV.put(LAST_RUN_KEY, String(NOON.getTime() - HOUR));
    h.deps.alertStale = () => Promise.reject(new Error("db down"));

    await expect(tick(h)).resolves.toMatchObject({ outcome: "idle" });
  });
});

describe("scheduled(): db lifecycle and cleanup", () => {
  it("opens the database only once when multiple tick hooks run concurrently", async () => {
    const h = harness();
    let dbCloses = 0;
    h.deps.openDb = async () => {
      h.dbOpens++;
      await Promise.resolve();
      return {} as unknown as Db;
    };
    h.deps.closeDb = () => {
      dbCloses++;
      return Promise.resolve();
    };
    await seedIdle(h);
    registerTickHook("hook-a", () => Promise.resolve());
    registerTickHook("hook-b", () => Promise.resolve());
    registerTickHook("hook-c", () => Promise.resolve());
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    const summary = await tick(h);

    expect(summary.outcome).toBe("ran");
    expect(h.dbOpens).toBe(1);
    expect(dbCloses).toBe(1);
  });

  it("still calls closeDb if KV lock cleanup throws in finally", async () => {
    const h = harness();
    let dbCloses = 0;
    h.deps.closeDb = () => {
      dbCloses++;
      return Promise.resolve();
    };
    await seedIdle(h);
    registerTickHook("hook-a", () => Promise.resolve());
    await env.KV.put(NEXT_DUE_KEY, String(NOON.getTime() - MINUTE));

    let getCount = 0;
    const kvWithFailingFinally = {
      get: async (key: string) => {
        if (key === LOCK_KEY) {
          getCount++;
          // 1st get: initial lock check; 2nd get: lock ownership check; 3rd get: finally cleanup -> throw.
          if (getCount >= 3) throw new Error("kv_finally_boom");
        }
        return env.KV.get(key);
      },
      put: (key: string, value: string, opts?: KVNamespacePutOptions) =>
        env.KV.put(key, value, opts),
      delete: (key: string) => env.KV.delete(key),
    } as unknown as KVNamespace;

    const summary = await runTick(
      { cron: CRON_FREQUENT, scheduledTime: h.clock.now().getTime() },
      { ...env, KV: kvWithFailingFinally },
      h.deps,
    );

    expect(summary.outcome).toBe("ran");
    expect(dbCloses).toBe(1);
  });
});
