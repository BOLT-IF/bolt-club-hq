import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createHealthHandler, cronIntervalMs, LAST_TICK_KEY, readLastTick, recordTick } from "./health";

const MINUTE = 60_000;
// 2026-11-23 is a Monday. 12:00 UTC is inside the 10-minute window (05-21 UTC).
const NOON_UTC = Date.UTC(2026, 10, 23, 12, 0, 0);
// 23:00 UTC is outside that window, so only the hourly trigger runs.
const NIGHT_UTC = Date.UTC(2026, 10, 23, 23, 0, 0);

interface HealthBody {
  status: string;
  db: { status: string };
  tick: { last_tick_at: string | null; stale: boolean; interval_ms: number };
  queue: { depth: number | null };
}

function healthApp(options: {
  now: number;
  lastTick: number | null;
  dbOk?: boolean;
  queueDepth?: number | null;
}) {
  const app = new Hono();
  app.get(
    "/healthz",
    createHealthHandler({
      clock: { now: () => options.now },
      probeDb: () => Promise.resolve(options.dbOk === false ? "error" : "ok"),
      lastTickAt: () => Promise.resolve(options.lastTick),
      queueDepth: () => Promise.resolve(options.queueDepth ?? 0),
    }),
  );
  return app;
}

async function getHealth(app: Hono): Promise<{ status: number; body: HealthBody }> {
  const res = await app.request("/healthz");
  return { status: res.status, body: (await res.json()) as HealthBody };
}

describe("/healthz tick staleness", () => {
  it("reports the tick as fresh within 2x the cron interval", async () => {
    const { status, body } = await getHealth(
      healthApp({ now: NOON_UTC, lastTick: NOON_UTC - 19 * MINUTE }),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.tick.stale).toBe(false);
  });

  it("reports the tick as stale after 2x the cron interval", async () => {
    const { status, body } = await getHealth(
      healthApp({ now: NOON_UTC, lastTick: NOON_UTC - 21 * MINUTE }),
    );
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.tick.stale).toBe(true);
    expect(body.tick.interval_ms).toBe(10 * MINUTE);
  });

  it("uses the hourly interval overnight, so 2x is two hours", async () => {
    expect(cronIntervalMs(NIGHT_UTC)).toBe(60 * MINUTE);
    const fresh = await getHealth(
      healthApp({ now: NIGHT_UTC, lastTick: NIGHT_UTC - 119 * MINUTE }),
    );
    expect(fresh.body.tick.stale).toBe(false);
    const stale = await getHealth(
      healthApp({ now: NIGHT_UTC, lastTick: NIGHT_UTC - 121 * MINUTE }),
    );
    expect(stale.body.tick.stale).toBe(true);
  });

  it("reports stale when no tick has ever been recorded", async () => {
    const { body } = await getHealth(healthApp({ now: NOON_UTC, lastTick: null }));
    expect(body.tick.last_tick_at).toBeNull();
    expect(body.tick.stale).toBe(true);
  });
});

describe("/healthz database and queue", () => {
  it("reports a database error as degraded with 503", async () => {
    const { status, body } = await getHealth(
      healthApp({ now: NOON_UTC, lastTick: NOON_UTC, dbOk: false }),
    );
    expect(status).toBe(503);
    expect(body.db.status).toBe("error");
  });

  it("reports the queue depth", async () => {
    const { body } = await getHealth(
      healthApp({ now: NOON_UTC, lastTick: NOON_UTC, queueDepth: 7 }),
    );
    expect(body.queue.depth).toBe(7);
    expect(body.tick.last_tick_at).toBe(new Date(NOON_UTC).toISOString());
  });
});

describe("tick recording", () => {
  it("writes the tick time to KV and reads it back", async () => {
    const store = new Map<string, string>();
    const kv = {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      put: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
    } as unknown as KVNamespace;

    expect(await readLastTick(kv)).toBeNull();
    await recordTick(kv, { now: () => NOON_UTC });
    expect(store.get(LAST_TICK_KEY)).toBe(String(NOON_UTC));
    expect(await readLastTick(kv)).toBe(NOON_UTC);
  });
});
