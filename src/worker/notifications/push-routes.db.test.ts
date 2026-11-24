import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pushSubscription } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const env = { ENV: "test", VAPID_PUBLIC_KEY: "BPublicKey" } as unknown as Cloudflare.Env;

const sub = (endpoint = "https://push.example.test/a") => ({
  endpoint,
  keys: { p256dh: "p256", auth: "auth" },
});

describe("push routes", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-01T12:00:00Z"),
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const call = (clerk: string | null, method: string, path: string, body?: unknown) =>
    routes.request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(clerk ? { [TEST_IDENTITY_HEADER]: clerk } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  it("serves the VAPID public key to members", async () => {
    const m = await makeMember(t.db);
    const res = await call(m.clerkUserId, "GET", "/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: "BPublicKey" });
    expect((await call(null, "GET", "/push/vapid-public-key")).status).toBe(401);
  });

  it("subscribes, and re-subscribing the same endpoint updates instead of duplicating", async () => {
    const m = await makeMember(t.db);
    expect((await call(m.clerkUserId, "POST", "/push/subscriptions", sub())).status).toBe(200);
    const again = { ...sub(), keys: { p256dh: "new", auth: "new" }, userAgent: "iPhone" };
    expect((await call(m.clerkUserId, "POST", "/push/subscriptions", again)).status).toBe(200);

    const rows = await t.db.select().from(pushSubscription);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memberId: m.id,
      endpoint: "https://push.example.test/a",
      keys: { p256dh: "new", auth: "new" },
      userAgent: "iPhone",
      failures: 0,
    });
  });

  it("a device that changes hands moves to the member who subscribed last", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await call(a.clerkUserId, "POST", "/push/subscriptions", sub());
    await call(b.clerkUserId, "POST", "/push/subscriptions", sub());
    const rows = await t.db.select().from(pushSubscription);
    expect(rows.map((r) => r.memberId)).toEqual([b.id]);
  });

  it("rejects a malformed or non-https subscription", async () => {
    const m = await makeMember(t.db);
    for (const bad of [
      {},
      { endpoint: "http://push.example.test/a", keys: { p256dh: "p", auth: "a" } },
      { endpoint: "https://push.example.test/a", keys: { p256dh: "p" } },
    ]) {
      expect((await call(m.clerkUserId, "POST", "/push/subscriptions", bad)).status).toBe(400);
    }
    expect(await t.db.select().from(pushSubscription)).toEqual([]);
  });

  it("unsubscribes only the caller's own endpoint", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await call(a.clerkUserId, "POST", "/push/subscriptions", sub());
    const other = await call(b.clerkUserId, "DELETE", "/push/subscriptions", {
      endpoint: sub().endpoint,
    });
    expect(await other.json()).toEqual({ deleted: 0 });
    const mine = await call(a.clerkUserId, "DELETE", "/push/subscriptions", {
      endpoint: sub().endpoint,
    });
    expect(await mine.json()).toEqual({ deleted: 1 });
    expect(await t.db.select().from(pushSubscription)).toEqual([]);
  });

  it("push coverage: admins only, counts active members with at least one device", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const withTwo = await makeMember(t.db);
    await makeMember(t.db); // active, no device
    const exited = await makeMember(t.db, { status: "inactive" });
    await call(withTwo.clerkUserId, "POST", "/push/subscriptions", sub("https://p.test/1"));
    await call(withTwo.clerkUserId, "POST", "/push/subscriptions", sub("https://p.test/2"));
    await t.db.insert(pushSubscription).values({
      id: "sub_exited",
      memberId: exited.id,
      endpoint: "https://p.test/3",
      keys: { p256dh: "p", auth: "a" },
    });

    expect((await call(withTwo.clerkUserId, "GET", "/admin/push-coverage")).status).toBe(403);
    const res = await call(admin.clerkUserId, "GET", "/admin/push-coverage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      activeMembers: 3,
      membersWithPush: 1,
      coveragePercent: 33,
      subscriptions: 2,
    });
  });
});
