import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notification, outboundPush } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { createNotifyPort } from "./notify";
import type { NotificationPolicy } from "./policy";

const clock = new FixedClock("2027-01-01T10:00:00Z");

const suppress: NotificationPolicy = {
  id: "test-suppress",
  order: 10,
  evaluate: () => Promise.resolve({ action: "suppress", reason: "muted" }),
};

describe("notify (production NotifyPort)", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  const input = (memberId: string, overrides: Record<string, string> = {}) => ({
    memberId,
    category: "rsvp_status",
    title: "You're in",
    body: "Monday 19:00",
    idempotencyKey: "rsvp:e1:m1",
    ...overrides,
  });

  it("writes the inbox row and queues one push", async () => {
    const m = await makeMember(t.db);
    await createNotifyPort({ db: t.db, clock, policies: [] }).notify(input(m.id));

    const rows = await t.db.select().from(notification);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memberId: m.id,
      category: "rsvp_status",
      title: "You're in",
      body: "Monday 19:00",
      readAt: null,
    });
    expect(rows[0]?.createdAt.toISOString()).toBe("2027-01-01T10:00:00.000Z");
    const pushes = await t.db.select().from(outboundPush);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      notificationId: rows[0]?.id,
      status: "queued",
      notBefore: null,
      attempts: 0,
    });
  });

  it("is idempotent: the same key twice gives one notification and one push", async () => {
    const m = await makeMember(t.db);
    const port = createNotifyPort({ db: t.db, clock, policies: [] });
    await port.notify(input(m.id));
    await port.notify(input(m.id));
    expect(await t.db.select().from(notification)).toHaveLength(1);
    expect(await t.db.select().from(outboundPush)).toHaveLength(1);
  });

  it("is idempotent under concurrency", async () => {
    const m = await makeMember(t.db);
    const port = createNotifyPort({ db: t.db, clock, policies: [] });
    await Promise.all(Array.from({ length: 5 }, () => port.notify(input(m.id))));
    expect(await t.db.select().from(notification)).toHaveLength(1);
    expect(await t.db.select().from(outboundPush)).toHaveLength(1);
  });

  it("a policy can suppress the push while the inbox entry is still written", async () => {
    const m = await makeMember(t.db);
    await createNotifyPort({ db: t.db, clock, policies: [suppress] }).notify(input(m.id));
    expect(await t.db.select().from(notification)).toHaveLength(1);
    expect(await t.db.select().from(outboundPush)).toHaveLength(0);
  });

  it("a retry of a suppressed notification does not queue a push later", async () => {
    const m = await makeMember(t.db);
    await createNotifyPort({ db: t.db, clock, policies: [suppress] }).notify(input(m.id));
    await createNotifyPort({ db: t.db, clock, policies: [] }).notify(input(m.id));
    expect(await t.db.select().from(outboundPush)).toHaveLength(0);
  });

  it("a deferral queues a deferred push with not_before", async () => {
    const m = await makeMember(t.db);
    const until = new Date("2027-01-02T07:00:00Z");
    const defer: NotificationPolicy = {
      id: "test-defer",
      order: 10,
      evaluate: () => Promise.resolve({ action: "defer", until, reason: "quiet hours" }),
    };
    await createNotifyPort({ db: t.db, clock, policies: [defer] }).notify(input(m.id));
    const [push] = await t.db.select().from(outboundPush);
    expect(push?.status).toBe("deferred");
    expect(push?.notBefore?.toISOString()).toBe(until.toISOString());
  });

  it("a policy that throws fails closed: inbox written, no push, error reported", async () => {
    const m = await makeMember(t.db);
    const boom: NotificationPolicy = {
      id: "boom",
      order: 10,
      evaluate: () => Promise.reject(new Error("db down")),
    };
    const onPolicyError = vi.fn();
    await createNotifyPort({ db: t.db, clock, policies: [boom], onPolicyError }).notify(
      input(m.id),
    );
    expect(await t.db.select().from(notification)).toHaveLength(1);
    expect(await t.db.select().from(outboundPush)).toHaveLength(0);
    expect(onPolicyError).toHaveBeenCalledOnce();
  });

  it("policies see the stored notification and run in the same transaction", async () => {
    const m = await makeMember(t.db);
    const seen: string[] = [];
    const spy: NotificationPolicy = {
      id: "spy",
      order: 10,
      evaluate: async (ctx) => {
        const rows = await ctx.db
          .select()
          .from(notification)
          .where(eq(notification.id, ctx.notification.id));
        seen.push(`${ctx.notification.memberId}:${String(rows.length)}`);
        return { action: "allow" };
      },
    };
    await createNotifyPort({ db: t.db, clock, policies: [spy] }).notify(input(m.id));
    expect(seen).toEqual([`${m.id}:1`]);
  });

  it("stores the given in-app link, else the category's screen", async () => {
    const m = await makeMember(t.db);
    const port = createNotifyPort({ db: t.db, clock, policies: [] });
    await port.notify({ ...input(m.id, { idempotencyKey: "k1" }), link: "/events/mon-1" });
    await port.notify(input(m.id, { idempotencyKey: "k2", category: "payment_due" }));
    await port.notify({
      ...input(m.id, { idempotencyKey: "k3", category: "payment_due" }),
      link: "https://evil.example",
    });
    const rows = await t.db.select().from(notification);
    const link = (key: string) => rows.find((r) => r.idempotencyKey === key)?.link;
    expect(link("k1")).toBe("/events/mon-1");
    expect(link("k2")).toBe("/money");
    expect(link("k3")).toBe("/money");
  });

  it("admin_tasks reach admins only; members get nothing", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const plain = await makeMember(t.db);
    const port = createNotifyPort({ db: t.db, clock, policies: [] });
    await port.notify(input(admin.id, { category: "admin_tasks", idempotencyKey: "a" }));
    await port.notify(input(plain.id, { category: "admin_tasks", idempotencyKey: "b" }));
    const rows = await t.db.select().from(notification);
    expect(rows.map((r) => r.memberId)).toEqual([admin.id]);
  });

  it("rejects an unknown category", async () => {
    const m = await makeMember(t.db);
    await expect(
      createNotifyPort({ db: t.db, clock, policies: [] }).notify(input(m.id, { category: "spam" })),
    ).rejects.toThrow(/category/);
    expect(await t.db.select().from(notification)).toHaveLength(0);
  });
});
