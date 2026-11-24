import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { outboundPush, pushSubscription } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { NEXT_DUE_KEY } from "../scheduler/schedule";
import { tickHooks } from "../scheduler/registry";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { createNotifyPort } from "./notify";
import { markPushDue, PUSH_TICK_HOOK, runPushTick, type PushEnv } from "./push-cron";
import type { PushTransport } from "./push-transport";

function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

const ok: PushTransport = { send: () => Promise.resolve({ kind: "ok" }) };
const fail: PushTransport = { send: () => Promise.resolve({ kind: "retry", status: 503 }) };

describe("push tick hook", () => {
  let t: TestDatabase;
  const clock = new FixedClock("2027-01-15T11:00:00Z");
  const now = clock.now();

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  async function queuedPush() {
    const m = await makeMember(t.db);
    await t.db.insert(pushSubscription).values({
      id: `sub_${m.id}`,
      memberId: m.id,
      endpoint: `https://push.example.test/${m.id}`,
      keys: { p256dh: "p", auth: "a" },
    });
    await createNotifyPort({ db: t.db, clock, policies: [] }).notify({
      memberId: m.id,
      category: "rsvp_status",
      title: "t",
      body: "b",
      idempotencyKey: m.id,
    });
  }

  it("is registered with the scheduler", () => {
    expect(tickHooks().has(PUSH_TICK_HOOK)).toBe(true);
  });

  it("skips while the VAPID secrets are unset; rows stay queued", async () => {
    await queuedPush();
    await runPushTick({ db: t.db, clock, now }, {});
    const [row] = await t.db.select().from(outboundPush);
    expect(row?.status).toBe("queued");
  });

  it("re-arms next_due_at at the backoff time after a 5xx", async () => {
    await queuedPush();
    const { kv, store } = fakeKv();
    await runPushTick({ db: t.db, clock, now }, { KV: kv } satisfies PushEnv, fail);
    expect(store.get(NEXT_DUE_KEY)).toBe(String(Date.parse("2027-01-15T11:10:00Z")));
  });

  it("leaves next_due_at alone when nothing is pending", async () => {
    await queuedPush();
    const { kv, store } = fakeKv();
    await runPushTick({ db: t.db, clock, now }, { KV: kv }, ok);
    expect(store.has(NEXT_DUE_KEY)).toBe(false);
  });

  it("markPushDue is a no-op without a Worker env (Node, no KV)", async () => {
    await expect(markPushDue(now)).resolves.toBeUndefined();
    await expect(markPushDue(now, null)).resolves.toBeUndefined();
  });
});
