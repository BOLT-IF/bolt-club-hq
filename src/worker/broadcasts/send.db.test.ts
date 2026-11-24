import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, member, notification, outboundPush } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import type { NotificationPolicy } from "../notifications/policy";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { sendBroadcast } from "./send";
import { makeCaptain, makeEvent, makeRsvp, makeSeries } from "./test-fixtures";

const clock = new FixedClock("2027-01-05T10:00:00Z");

/** Stand-in for S6.3's mute policy: a globally muted member gets no push. */
const muteByGlobalFlag: NotificationPolicy = {
  id: "test-mute",
  order: 10,
  evaluate: async ({ db, notification: n }) => {
    const [m] = await db
      .select({ mute: member.globalMute })
      .from(member)
      .where(eq(member.id, n.memberId));
    return m?.mute ? { action: "suppress", reason: "muted" } : { action: "allow" };
  },
};

describe("sendBroadcast", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });
  afterEach(async () => {
    await t.close();
  });

  it("writes an announcements inbox row and queues a push for each recipient", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const a = await makeMember(t.db);
    const result = await sendBroadcast(
      { db: t.db, clock, policies: [] },
      {
        id: "b1",
        actorId: admin.id,
        title: "Hall closed",
        body: "No play on Monday",
        audience: { kind: "all" },
      },
    );
    expect(result).toEqual({ broadcastId: "b1", recipientCount: 2 });
    const rows = await t.db.select().from(notification);
    expect(rows.map((r) => r.memberId).sort()).toEqual([admin.id, a.id].sort());
    expect(rows.every((r) => r.category === "announcements" && r.title === "Hall closed")).toBe(
      true,
    );
    expect(rows.every((r) => r.body === "No play on Monday")).toBe(true);
    expect(await t.db.select().from(outboundPush)).toHaveLength(2);
  });

  it("sends only to the chosen audience", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const s = await makeSeries(t.db);
    const cap = await makeMember(t.db);
    await makeMember(t.db);
    await makeCaptain(t.db, s, cap.id);
    await sendBroadcast(
      { db: t.db, clock, policies: [] },
      {
        id: "b2",
        actorId: admin.id,
        title: "Captains",
        body: "Meeting",
        audience: { kind: "captains" },
      },
    );
    const rows = await t.db.select().from(notification);
    expect(rows.map((r) => r.memberId)).toEqual([cap.id]);
  });

  it("an event audience deep-links to the event", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const e = await makeEvent(t.db, admin.id);
    const m = await makeMember(t.db);
    await makeRsvp(t.db, e.id, m.id, "confirmed");
    await sendBroadcast(
      { db: t.db, clock, policies: [] },
      {
        id: "b3",
        actorId: admin.id,
        title: "Court change",
        body: "Court 3",
        audience: { kind: "event_rsvps", eventId: e.id },
      },
    );
    const [row] = await t.db.select().from(notification);
    expect(row?.link).toBe(`/events/${e.shareSlug}`);
  });

  it("mute is respected: a muted member keeps the inbox entry but gets no push", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const loud = await makeMember(t.db);
    const muted = await makeMember(t.db);
    await t.db.update(member).set({ globalMute: true }).where(eq(member.id, muted.id));
    await sendBroadcast(
      { db: t.db, clock, policies: [muteByGlobalFlag] },
      { id: "b4", actorId: admin.id, title: "Hi", body: "All", audience: { kind: "all" } },
    );
    const rows = await t.db.select().from(notification);
    expect(rows).toHaveLength(3);
    const pushes = await t.db.select().from(outboundPush);
    const pushed = rows
      .filter((r) => pushes.some((p) => p.notificationId === r.id))
      .map((r) => r.memberId);
    expect(pushed.sort()).toEqual([admin.id, loud.id].sort());
    expect(pushed).not.toContain(muted.id);
  });

  it("is idempotent: sending the same broadcast id twice notifies each member once", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await makeMember(t.db);
    const input = {
      id: "b5",
      actorId: admin.id,
      title: "Hi",
      body: "All",
      audience: { kind: "all" },
    } as const;
    await sendBroadcast({ db: t.db, clock, policies: [] }, input);
    await sendBroadcast({ db: t.db, clock, policies: [] }, input);
    expect(await t.db.select().from(notification)).toHaveLength(2);
    expect(await t.db.select().from(outboundPush)).toHaveLength(2);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it("audits every broadcast, including one with no recipients", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await sendBroadcast(
      { db: t.db, clock, policies: [] },
      {
        id: "b6",
        actorId: admin.id,
        title: "Nobody",
        body: "Empty",
        audience: { kind: "captains" },
      },
    );
    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      action: "broadcast.send",
      entity: "broadcast",
      entityId: "b6",
    });
    expect(rows[0]?.at.toISOString()).toBe("2027-01-05T10:00:00.000Z");
    expect(JSON.parse(rows[0]?.after ?? "null")).toMatchObject({
      title: "Nobody",
      audience: { kind: "captains" },
      recipientCount: 0,
    });
  });

  it("an unknown event sends nothing and audits nothing", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await expect(
      sendBroadcast(
        { db: t.db, clock, policies: [] },
        {
          id: "b7",
          actorId: admin.id,
          title: "x",
          body: "y",
          audience: { kind: "event_rsvps", eventId: "nope" },
        },
      ),
    ).rejects.toMatchObject({ code: "event_not_found" });
    expect(await t.db.select().from(notification)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
