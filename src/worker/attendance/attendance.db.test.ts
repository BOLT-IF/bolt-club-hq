import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditLog,
  event,
  guest,
  ledgerEntry,
  notification,
  pass,
  rsvp,
  series,
  seriesCaptain,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createLedgerService } from "../ledger/service";
import { requestIdMiddleware } from "../ops/logging";
import { closeEvent } from "../rsvp/close";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import { runAttendanceAlertTick } from "./alert-tick";
import attendanceRoutes from "./routes";

const ENDS_AT = new Date("2027-04-01T19:30:00Z");
const STARTS_AT = new Date("2027-04-01T18:00:00Z");
const RSVP_CLOSE_AT = new Date("2027-04-01T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("attendance marking (S8.1)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/api/v1", attendanceRoutes);

  const send = async (
    method: "GET" | "PUT",
    path: string,
    clerkUserId: string,
    opts: { body?: unknown; key?: string | null } = {},
  ) => {
    const headers: Record<string, string> = { [TEST_IDENTITY_HEADER]: clerkUserId };
    if (method === "PUT" && opts.key !== null) {
      headers["Idempotency-Key"] = opts.key ?? `att-k-${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return app().request(`/api/v1${path}`, init, testEnv);
  };

  async function seedSeriesEvent(
    creatorId: string,
    opts: {
      adhocFee?: number;
      capacity?: number;
      status?: "scheduled" | "closed" | "cancelled" | "completed";
    } = {},
  ) {
    const [trm] = await t.db
      .insert(term)
      .values({
        id: "trm_1",
        name: "Spring 2027",
        startsOn: "2027-01-01",
        endsOn: "2027-06-30",
        status: "active",
      })
      .returning();
    const [ser] = await t.db
      .insert(series)
      .values({
        id: "ser_1",
        termId: trm!.id,
        name: "Thursday Mixed",
        format: "Mixed Doubles",
        weekday: 4,
        startTime: "18:00",
        durationMin: 90,
        capacity: 12,
        passPrice: 500,
        adhocFee: opts.adhocFee ?? 100,
        passCap: 10,
        maxGuestsDefault: 1,
        rsvpCloseOffsetMin: 360,
        shareSlug: "thu-mix",
      })
      .returning();
    const [evt] = await t.db
      .insert(event)
      .values({
        id: "evt_1",
        seriesId: ser!.id,
        kind: "series",
        createdBy: creatorId,
        title: "Thursday Mixed #1",
        format: "Mixed Doubles",
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        location: "Hall X",
        capacity: opts.capacity ?? 12,
        adhocFee: opts.adhocFee ?? 100,
        maxGuestsPerMember: 1,
        rsvpCloseAt: RSVP_CLOSE_AT,
        allocationMode: "tiered",
        status: opts.status ?? "scheduled",
        shareSlug: "thu-mix-1",
      })
      .returning();
    return { ser: ser!, evt: evt! };
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(new Date(ENDS_AT.getTime() + 60 * 60 * 1000));
    keySeq = 0;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  it("a prepaid no-show changes nothing in the ledger", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const prepaidMember = await makeMember(t.db, { displayName: "Prepaid Pat" });
    const { ser, evt } = await seedSeriesEvent(admin.id, { adhocFee: 100 });

    await t.db.insert(pass).values({
      id: "pas_1",
      memberId: prepaidMember.id,
      seriesId: ser.id,
      priceCharged: 500,
      eventsCovered: 10,
      status: "active",
    });
    const ledger = createLedgerService({ db: t.db, clock });
    await ledger.charge({
      memberId: prepaidMember.id,
      amountSek: 500,
      reason: "pass",
      passId: "pas_1",
      idempotencyKey: "pass:pas_1",
    });

    const [r] = await t.db
      .insert(rsvp)
      .values({
        id: "rsvp_pre",
        eventId: evt.id,
        memberId: prepaidMember.id,
        status: "confirmed",
        tier: 1,
        requestedAt: new Date(RSVP_CLOSE_AT.getTime() - HOUR),
        confirmedAt: new Date(RSVP_CLOSE_AT.getTime() - HOUR),
      })
      .returning();

    const closeClock = new FixedClock(new Date(RSVP_CLOSE_AT.getTime() + 1000));
    await closeEvent(t.db, closeClock, evt.id);

    const res = await send("PUT", `/events/${evt.id}/attendance`, admin.clerkUserId, {
      body: { rsvps: [{ id: r!.id, attendance: "no_show" }], guests: [] },
    });
    expect(res.status).toBe(200);

    const [updated] = await t.db.select().from(rsvp).where(eq(rsvp.id, r!.id));
    expect(updated?.attendance).toBe("no_show");

    const entries = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, prepaidMember.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe("pass");
    expect(entries[0]?.amountSek).toBe(500);
  });

  it("a non-prepaid no-show's charge stands (including confirmed guests)", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const adhocMember = await makeMember(t.db, { displayName: "Adhoc Alex" });
    const hostMember = await makeMember(t.db, { displayName: "Host Hanna" });
    const { ser, evt } = await seedSeriesEvent(admin.id, { adhocFee: 120, capacity: 3 });

    await t.db.insert(pass).values({
      id: "pas_host",
      memberId: hostMember.id,
      seriesId: ser.id,
      priceCharged: 500,
      eventsCovered: 10,
      status: "active",
    });

    const [rAdhoc] = await t.db
      .insert(rsvp)
      .values({
        id: "rsvp_adhoc",
        eventId: evt.id,
        memberId: adhocMember.id,
        status: "requested",
        tier: 2,
        requestedAt: new Date(RSVP_CLOSE_AT.getTime() - 2 * HOUR),
      })
      .returning();

    const [rHost] = await t.db
      .insert(rsvp)
      .values({
        id: "rsvp_host",
        eventId: evt.id,
        memberId: hostMember.id,
        status: "confirmed",
        tier: 1,
        requestedAt: new Date(RSVP_CLOSE_AT.getTime() - 2 * HOUR),
        confirmedAt: new Date(RSVP_CLOSE_AT.getTime() - 2 * HOUR),
      })
      .returning();

    const [gst] = await t.db
      .insert(guest)
      .values({
        id: "gst_1",
        rsvpId: rHost!.id,
        name: "Guest Gus",
        status: "requested",
        tier: 3,
        requestedAt: new Date(RSVP_CLOSE_AT.getTime() - HOUR),
      })
      .returning();

    const closeClock = new FixedClock(new Date(RSVP_CLOSE_AT.getTime() + 1000));
    await closeEvent(t.db, closeClock, evt.id);

    // Waitlisted member should NOT appear in attendance list
    const waitlistedMember = await makeMember(t.db, { displayName: "Waitlist Will" });
    await t.db.insert(rsvp).values({
      id: "rsvp_wait",
      eventId: evt.id,
      memberId: waitlistedMember.id,
      status: "waitlisted",
      tier: 2,
      requestedAt: new Date(RSVP_CLOSE_AT.getTime() - HOUR),
    });

    const getRes = await send("GET", `/events/${evt.id}/attendance`, admin.clerkUserId);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json<{
      hasUnmarked: boolean;
      attendees: Array<{
        kind: string;
        id: string;
        attendance: string;
        effectiveAttendance: string;
      }>;
    }>();
    expect(getBody.hasUnmarked).toBe(true);
    expect(getBody.attendees.map((a) => a.id).sort()).toEqual(["gst_1", "rsvp_adhoc", "rsvp_host"]);
    expect(getBody.attendees.every((a) => a.effectiveAttendance === "attended")).toBe(true);

    const putRes = await send("PUT", `/events/${evt.id}/attendance`, admin.clerkUserId, {
      body: {
        rsvps: [
          { id: rAdhoc!.id, attendance: "no_show" },
          { id: rHost!.id, attendance: "attended" },
        ],
        guests: [{ id: gst!.id, attendance: "no_show" }],
      },
    });
    expect(putRes.status).toBe(200);

    const adhocLedger = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, adhocMember.id));
    expect(adhocLedger).toHaveLength(1);
    expect(adhocLedger[0]?.amountSek).toBe(120);
    expect(adhocLedger[0]?.reason).toBe("adhoc");

    const hostLedger = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, hostMember.id));
    expect(hostLedger).toHaveLength(1);
    expect(hostLedger[0]?.amountSek).toBe(120);
    expect(hostLedger[0]?.reason).toBe("guest");

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, evt.id));
    expect(audits.some((a) => a.action === "attendance.mark")).toBe(true);
  });

  it("enforces permissions: organizer (one-off), captain (own series), admin", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const captain = await makeMember(t.db);
    const otherCaptain = await makeMember(t.db);
    const plain = await makeMember(t.db);
    const pending = await makeMember(t.db, { status: "pending" });

    const { ser, evt } = await seedSeriesEvent(admin.id);
    await t.db.insert(seriesCaptain).values({ seriesId: ser.id, memberId: captain.id });

    // Other series + captain
    const [ser2] = await t.db
      .insert(series)
      .values({
        id: "ser_2",
        termId: "trm_1",
        name: "Other Series",
        format: "Open",
        weekday: 2,
        startTime: "18:00",
        durationMin: 90,
        capacity: 12,
        passPrice: 500,
        adhocFee: 100,
        passCap: 10,
        maxGuestsDefault: 0,
        rsvpCloseOffsetMin: 360,
        shareSlug: "other-ser",
      })
      .returning();
    await t.db.insert(seriesCaptain).values({ seriesId: ser2!.id, memberId: otherCaptain.id });

    // One-off created by plain member
    const [oneoff] = await t.db
      .insert(event)
      .values({
        id: "evt_oneoff",
        seriesId: null,
        kind: "member_oneoff",
        createdBy: plain.id,
        title: "Saturday Pickup",
        format: "Open",
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        location: "Park",
        capacity: 10,
        adhocFee: 0,
        maxGuestsPerMember: 0,
        rsvpCloseAt: RSVP_CLOSE_AT,
        allocationMode: "instant",
        status: "closed",
        shareSlug: "sat-pick",
      })
      .returning();

    // Plain & other captain & pending denied on ser_1 event
    expect((await send("GET", `/events/${evt.id}/attendance`, plain.clerkUserId)).status).toBe(403);
    expect(
      (
        await send("PUT", `/events/${evt.id}/attendance`, plain.clerkUserId, {
          body: { rsvps: [], guests: [] },
        })
      ).status,
    ).toBe(403);
    expect(
      (await send("GET", `/events/${evt.id}/attendance`, otherCaptain.clerkUserId)).status,
    ).toBe(403);
    expect((await send("GET", `/events/${evt.id}/attendance`, pending.clerkUserId)).status).toBe(
      403,
    );

    // Captain of ser_1 allowed
    expect((await send("GET", `/events/${evt.id}/attendance`, captain.clerkUserId)).status).toBe(
      200,
    );
    expect(
      (
        await send("PUT", `/events/${evt.id}/attendance`, captain.clerkUserId, {
          body: { rsvps: [], guests: [] },
        })
      ).status,
    ).toBe(200);

    // Creator of one-off allowed; other captain denied
    expect((await send("GET", `/events/${oneoff!.id}/attendance`, plain.clerkUserId)).status).toBe(
      200,
    );
    expect(
      (await send("GET", `/events/${oneoff!.id}/attendance`, otherCaptain.clerkUserId)).status,
    ).toBe(403);
  });

  it("enforces the 7-day lock: editable for 7 days, then admin only", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const captain = await makeMember(t.db);
    const player = await makeMember(t.db);
    const { ser, evt } = await seedSeriesEvent(admin.id);
    await t.db.insert(seriesCaptain).values({ seriesId: ser.id, memberId: captain.id });
    const [r] = await t.db
      .insert(rsvp)
      .values({
        id: "rsvp_1",
        eventId: evt.id,
        memberId: player.id,
        status: "confirmed",
        tier: 1,
        requestedAt: RSVP_CLOSE_AT,
        confirmedAt: RSVP_CLOSE_AT,
      })
      .returning();

    // 1 ms before 7 days: captain can edit
    clock.set(new Date(ENDS_AT.getTime() + 7 * DAY - 1));
    const beforeGet = await send("GET", `/events/${evt.id}/attendance`, captain.clerkUserId);
    expect(beforeGet.status).toBe(200);
    expect(await beforeGet.json()).toMatchObject({ lockedForOrganizer: false, canEdit: true });

    const beforePut = await send("PUT", `/events/${evt.id}/attendance`, captain.clerkUserId, {
      body: { rsvps: [{ id: r!.id, attendance: "attended" }], guests: [] },
    });
    expect(beforePut.status).toBe(200);

    // At exactly 7 days: captain locked out, admin still allowed
    clock.set(new Date(ENDS_AT.getTime() + 7 * DAY));
    const lockedGet = await send("GET", `/events/${evt.id}/attendance`, captain.clerkUserId);
    expect(lockedGet.status).toBe(200);
    expect(await lockedGet.json()).toMatchObject({ lockedForOrganizer: true, canEdit: false });

    const lockedPut = await send("PUT", `/events/${evt.id}/attendance`, captain.clerkUserId, {
      body: { rsvps: [{ id: r!.id, attendance: "no_show" }], guests: [] },
    });
    expect(lockedPut.status).toBe(403);
    expect(await lockedPut.json()).toMatchObject({ error: "attendance_locked" });

    // Admin can still edit after 7 days
    const adminGet = await send("GET", `/events/${evt.id}/attendance`, admin.clerkUserId);
    expect(await adminGet.json()).toMatchObject({ lockedForOrganizer: true, canEdit: true });

    const adminPut = await send("PUT", `/events/${evt.id}/attendance`, admin.clerkUserId, {
      body: { rsvps: [{ id: r!.id, attendance: "no_show" }], guests: [] },
    });
    expect(adminPut.status).toBe(200);

    const [row] = await t.db.select().from(rsvp).where(eq(rsvp.id, r!.id));
    expect(row?.attendance).toBe("no_show");
  });

  it("alerts active admins via admin_tasks if attendance is still unmarked 24h after the event", async () => {
    const admin1 = await makeMember(t.db, { role: "admin" });
    const admin2 = await makeMember(t.db, { role: "admin" });
    const inactiveAdmin = await makeMember(t.db, { role: "admin", status: "inactive" });
    const player = await makeMember(t.db);
    const { evt } = await seedSeriesEvent(admin1.id);

    await t.db.insert(rsvp).values({
      id: "rsvp_unmarked",
      eventId: evt.id,
      memberId: player.id,
      status: "confirmed",
      tier: 1,
      requestedAt: RSVP_CLOSE_AT,
      confirmedAt: RSVP_CLOSE_AT,
    });

    // Before 24h: no alert
    const before24h = new Date(ENDS_AT.getTime() + 24 * HOUR - 1000);
    await runAttendanceAlertTick({
      db: t.db,
      clock: new FixedClock(before24h),
      now: before24h,
    });
    expect(await t.db.select().from(notification)).toHaveLength(0);

    // At 24h: alerts active admins once
    const at24h = new Date(ENDS_AT.getTime() + 24 * HOUR);
    await runAttendanceAlertTick({
      db: t.db,
      clock: new FixedClock(at24h),
      now: at24h,
    });

    const notes = await t.db.select().from(notification);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.memberId).sort()).toEqual([admin1.id, admin2.id].sort());
    expect(notes.every((n) => n.category === "admin_tasks")).toBe(true);
    expect(notes.every((n) => n.link === `/events/${evt.shareSlug}`)).toBe(true);
    expect(notes.some((n) => n.memberId === inactiveAdmin.id)).toBe(false);

    // Re-running is idempotent
    await runAttendanceAlertTick({
      db: t.db,
      clock: new FixedClock(new Date(at24h.getTime() + HOUR)),
      now: new Date(at24h.getTime() + HOUR),
    });
    expect(await t.db.select().from(notification)).toHaveLength(2);
  });

  it("does not alert if attendance was already marked before 24h", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const player = await makeMember(t.db);
    const { evt } = await seedSeriesEvent(admin.id);

    const [r] = await t.db
      .insert(rsvp)
      .values({
        id: "rsvp_marked",
        eventId: evt.id,
        memberId: player.id,
        status: "confirmed",
        tier: 1,
        requestedAt: RSVP_CLOSE_AT,
        confirmedAt: RSVP_CLOSE_AT,
      })
      .returning();

    await send("PUT", `/events/${evt.id}/attendance`, admin.clerkUserId, {
      body: { rsvps: [{ id: r!.id, attendance: "attended" }], guests: [] },
    });

    const at24h = new Date(ENDS_AT.getTime() + 24 * HOUR);
    await runAttendanceAlertTick({
      db: t.db,
      clock: new FixedClock(at24h),
      now: at24h,
    });
    expect(await t.db.select().from(notification)).toHaveLength(0);
  });
});
