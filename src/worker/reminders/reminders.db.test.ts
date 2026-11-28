import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  event,
  eventEligibleMember,
  member,
  notification,
  notificationPref,
  notificationSendLog,
  outboundPush,
  reminderRule,
  rsvp,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import type { NotificationPolicy } from "../notifications/policy";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeLedgerEntry, makeMember } from "../test-support/factories";
import routes from "./routes";
import { runReminders } from "./service";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const DAY_MS = 86_400_000;

/**
 * Stand-in for S6.3's mute policy (PR #33): suppresses the push for a globally muted member or
 * a muted category. Reminders go through the notify chain, so the real policy applies the same way.
 */
const testMute: NotificationPolicy = {
  id: "test-mute",
  order: 10,
  async evaluate({ db, notification: n }) {
    const [m] = await db
      .select({ g: member.globalMute })
      .from(member)
      .where(eq(member.id, n.memberId));
    const [p] = await db
      .select({ muted: notificationPref.muted })
      .from(notificationPref)
      .where(
        and(eq(notificationPref.memberId, n.memberId), eq(notificationPref.category, n.category)),
      );
    return m?.g || p?.muted ? { action: "suppress", reason: "muted" } : { action: "allow" };
  },
};

describe("reminders engine (S6.5a)", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-01-01T09:00:00Z");
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const run = () => runReminders({ db: t.db, clock, policies: [testMute] });
  const as = (
    clerk: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): RequestInit => ({
    ...init,
    headers: { [TEST_IDENTITY_HEADER]: clerk, "Content-Type": "application/json", ...init.headers },
  });

  async function paymentRule(thresholdSek = 200, minIntervalDays = 90) {
    await t.db.insert(reminderRule).values({
      id: "r_pay",
      category: "payment_due",
      params: { thresholdSek },
      minIntervalDays,
      template: "Hi {name}, you owe {balance}",
    });
  }

  async function makeEvent(createdBy: string, rsvpCloseAt: Date, id = "e1") {
    await t.db.insert(event).values({
      id,
      kind: "admin_oneoff",
      createdBy,
      title: "Thursday doubles",
      format: "Open",
      startsAt: new Date(rsvpCloseAt.getTime() + DAY_MS),
      endsAt: new Date(rsvpCloseAt.getTime() + DAY_MS + 5_400_000),
      capacity: 12,
      adhocFee: 120,
      rsvpCloseAt,
      allocationMode: "instant",
      shareSlug: `slug-${id}`,
    });
  }

  it("a 500 kr balance from 2027-01-01 with a 90-day rule sends on 01-01 and 04-01 only", async () => {
    const m = await makeMember(t.db);
    await makeLedgerEntry(t.db, m.id, { amountSek: 500 });
    await paymentRule();

    const sentOn: string[] = [];
    for (let day = 0; day < 120; day++) {
      clock.set(new Date(Date.parse("2027-01-01T09:00:00Z") + day * DAY_MS));
      if ((await run()).sent > 0) sentOn.push(clock.now().toISOString().slice(0, 10));
    }
    expect(sentOn).toEqual(["2027-01-01", "2027-04-01"]);
    const inbox = await t.db.select().from(notification).where(eq(notification.memberId, m.id));
    expect(inbox.map((n) => n.body)).toEqual([
      "Hi Member " + m.id + ", you owe 500 kr",
      "Hi Member " + m.id + ", you owe 500 kr",
    ]);
    expect(inbox.every((n) => n.category === "payment_due" && n.link === "/money")).toBe(true);
  });

  it("paying below the threshold stops the reminders", async () => {
    const m = await makeMember(t.db);
    await makeLedgerEntry(t.db, m.id, { amountSek: 500 });
    await paymentRule(200, 30);
    expect((await run()).sent).toBe(1);

    await makeLedgerEntry(t.db, m.id, { amountSek: -400, kind: "payment", reason: "payment" });
    clock.set("2027-03-01T09:00:00Z");
    expect((await run()).sent).toBe(0);
  });

  it("a retried tick on the same day sends nothing twice", async () => {
    const m = await makeMember(t.db);
    await makeLedgerEntry(t.db, m.id, { amountSek: 500 });
    await paymentRule();
    await run();
    await run();
    expect(await t.db.select().from(notificationSendLog)).toHaveLength(1);
    expect(await t.db.select().from(notification)).toHaveLength(1);
  });

  it("the un-RSVPed rule skips members who responded", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const responded = await makeMember(t.db);
    const silent = await makeMember(t.db);
    await makeEvent(admin.id, new Date("2027-01-03T17:00:00Z"));
    await t.db.insert(rsvp).values({
      id: "rsvp1",
      eventId: "e1",
      memberId: responded.id,
      status: "confirmed",
      tier: 1,
      requestedAt: clock.now(),
    });
    await t.db.insert(reminderRule).values({
      id: "r_ev",
      category: "event_unrsvped",
      params: { atPublish: true, hoursBeforeClose: null },
      template: "{name}, coming to {event}?",
    });

    expect((await run()).sent).toBe(2); // admin + silent
    const to = (await t.db.select().from(notification)).map((n) => n.memberId).sort();
    expect(to).toEqual([admin.id, silent.id].sort());
    expect((await run()).sent).toBe(0); // the publish stage goes out once
  });

  it("excludes members who explicitly declined (Not going) from event_unrsvped reminders", async () => {
    const declined = await makeMember(t.db);
    const unanswered = await makeMember(t.db);
    await makeEvent(declined.id, new Date("2027-01-03T17:00:00Z"));
    await t.db.insert(rsvp).values({
      id: "r_declined",
      eventId: "e1",
      memberId: declined.id,
      status: "declined",
      tier: 2,
      requestedAt: clock.now(),
    });
    await t.db.insert(reminderRule).values({
      id: "r_ev",
      category: "event_unrsvped",
      params: { atPublish: true, hoursBeforeClose: null },
      template: "{name}, coming to {event}?",
    });

    expect((await run()).sent).toBe(1);
    const to = (await t.db.select().from(notification)).map((n) => n.memberId);
    expect(to).toEqual([unanswered.id]);
  });

  it("a muted member gets the inbox entry only", async () => {
    const muted = await makeMember(t.db);
    const loud = await makeMember(t.db);
    await t.db.update(member).set({ globalMute: true }).where(eq(member.id, muted.id));
    for (const m of [muted, loud]) await makeLedgerEntry(t.db, m.id, { amountSek: 500 });
    await paymentRule();

    expect((await run()).sent).toBe(2);
    const rows = await t.db
      .select({ memberId: notification.memberId, push: outboundPush.id })
      .from(notification)
      .leftJoin(outboundPush, eq(outboundPush.notificationId, notification.id));
    const byMember = new Map(rows.map((r) => [r.memberId, r.push]));
    expect(byMember.get(muted.id)).toBeNull();
    expect(byMember.get(loud.id)).not.toBeNull();
  });

  it("the preview count equals the number actually sent", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    for (const amount of [500, 300, 199, -50]) {
      const m = await makeMember(t.db);
      await makeLedgerEntry(t.db, m.id, { amountSek: amount });
    }
    const exited = await makeMember(t.db, { status: "inactive" });
    await makeLedgerEntry(t.db, exited.id, { amountSek: 250 });
    await paymentRule();

    const res = await routes.request(
      "/admin/reminder-rules/r_pay/preview",
      as(admin.clerkUserId, { method: "POST" }),
      testEnv,
    );
    expect(res.status).toBe(200);
    const preview = await res.json<{ count: number; sample: { body: string } | null }>();
    expect(preview.count).toBe(3);
    expect(preview.sample?.body).toMatch(/you owe \d+ kr/);

    expect((await run()).sent).toBe(preview.count);
    // After the send, the preview reflects the interval: nobody is due.
    const after = await routes.request(
      "/admin/reminder-rules/r_pay/preview",
      as(admin.clerkUserId, { method: "POST" }),
      testEnv,
    );
    expect((await after.json<{ count: number }>()).count).toBe(0);
  });

  describe("rules API", () => {
    it("members get 403 on every route", async () => {
      const m = await makeMember(t.db);
      await paymentRule();
      const calls: Array<[string, string]> = [
        ["GET", "/admin/reminder-rules"],
        ["POST", "/admin/reminder-rules"],
        ["PUT", "/admin/reminder-rules/r_pay"],
        ["DELETE", "/admin/reminder-rules/r_pay"],
        ["POST", "/admin/reminder-rules/r_pay/preview"],
      ];
      for (const [method, path] of calls) {
        const res = await routes.request(
          path,
          as(
            m.clerkUserId,
            method === "GET" || method === "DELETE" ? { method } : { method, body: "{}" },
          ),
          testEnv,
        );
        expect(`${method} ${path} ${String(res.status)}`).toBe(`${method} ${path} 403`);
      }
    });

    it("creates (idempotently), lists, updates and deletes a rule; rejects unknown placeholders", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const body = JSON.stringify({
        kind: "payment_due",
        template: "Hi {name}",
        params: { thresholdSek: 300 },
      });
      const create = () =>
        routes.request(
          "/admin/reminder-rules",
          as(admin.clerkUserId, { method: "POST", body, headers: { "Idempotency-Key": "k1" } }),
          testEnv,
        );
      const first = await create();
      expect(first.status).toBe(201);
      const rule = await first.json<{ id: string; minIntervalDays: number }>();
      expect(rule.minIntervalDays).toBe(90);
      await create();
      expect(await t.db.select().from(reminderRule)).toHaveLength(1);

      const bad = await routes.request(
        `/admin/reminder-rules/${rule.id}`,
        as(admin.clerkUserId, {
          method: "PUT",
          body: JSON.stringify({
            kind: "payment_due",
            template: "{nope}",
            params: { thresholdSek: 300 },
          }),
        }),
        testEnv,
      );
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: "validation",
        fields: { template: "unknown placeholder: {nope}" },
      });

      const put = await routes.request(
        `/admin/reminder-rules/${rule.id}`,
        as(admin.clerkUserId, {
          method: "PUT",
          body: JSON.stringify({
            kind: "payment_due",
            enabled: false,
            template: "Owe {balance}",
            params: { thresholdSek: 100 },
          }),
        }),
        testEnv,
      );
      expect(await put.json()).toMatchObject({
        enabled: false,
        template: "Owe {balance}",
        params: { thresholdSek: 100 },
      });

      const list = await routes.request("/admin/reminder-rules", as(admin.clerkUserId), testEnv);
      const listed = await list.json<{
        items: unknown[];
        placeholders: Record<string, string[]>;
      }>();
      expect(listed.items).toHaveLength(1);
      expect(listed.placeholders.payment_due).toContain("balance");

      const del = await routes.request(
        `/admin/reminder-rules/${rule.id}`,
        as(admin.clerkUserId, { method: "DELETE" }),
        testEnv,
      );
      expect(del.status).toBe(204);
    });

    it("a rule that has sent cannot be deleted, and a disabled rule sends nothing", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await makeLedgerEntry(t.db, m.id, { amountSek: 500 });
      await paymentRule();
      await run();
      const del = await routes.request(
        "/admin/reminder-rules/r_pay",
        as(admin.clerkUserId, { method: "DELETE" }),
        testEnv,
      );
      expect(del.status).toBe(409);

      await t.db.update(reminderRule).set({ enabled: false });
      clock.set("2027-06-01T09:00:00Z");
      expect((await run()).sent).toBe(0);
    });

    it("excludes ineligible members from event_unrsvped reminders for invite-only (members) events", async () => {
      const organizer = await makeMember(t.db, { role: "admin" });
      const invited = await makeMember(t.db);
      const outsider = await makeMember(t.db);

      await t.db.insert(event).values({
        id: "e_invite_only",
        shareSlug: "slug_invite_only",
        kind: "member_oneoff",
        createdBy: organizer.id,
        title: "Secret Match",
        format: "Mixed Doubles",
        startsAt: new Date("2027-01-03T18:00:00Z"),
        endsAt: new Date("2027-01-03T19:30:00Z"),
        location: "Hall Secret",
        capacity: 4,
        adhocFee: 0,
        maxGuestsPerMember: 1,
        rsvpCloseAt: new Date("2027-01-03T17:00:00Z"),
        allocationMode: "instant",
        status: "scheduled",
        audienceKind: "members",
      });
      await t.db.insert(eventEligibleMember).values({
        eventId: "e_invite_only",
        memberId: invited.id,
      });
      await t.db.insert(reminderRule).values({
        id: "r_ev_invite",
        category: "event_unrsvped",
        params: { atPublish: true, hoursBeforeClose: null },
        template: "{name}, coming to {event}?",
      });

      const res = await run();
      expect(res.sent).toBe(1);
      const sentTo = (await t.db.select().from(notification)).map((n) => n.memberId);
      expect(sentTo).toEqual([invited.id]);
      expect(sentTo).not.toContain(outsider.id);
    });
  });
});
