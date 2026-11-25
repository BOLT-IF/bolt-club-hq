import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { event, guest, pass, rsvp, series, term } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createLedgerService } from "../ledger/service";
import { requestIdMiddleware } from "../ops/logging";
import { closeEvent } from "../rsvp/close";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import attendanceRoutes from "./routes";

const STARTS_AT = new Date("2027-04-01T18:00:00Z");
const ENDS_AT = new Date("2027-04-01T19:30:00Z");
const RSVP_CLOSE_AT = new Date("2027-04-01T12:00:00Z");
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("member attendance & why history (S8.2)", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/api/v1", attendanceRoutes);

  const getHistory = (clerkUserId: string, query = "") =>
    app().request(
      `/api/v1/me/attendance${query}`,
      { method: "GET", headers: { [TEST_IDENTITY_HEADER]: clerkUserId } },
      testEnv,
    );

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(new Date("2027-04-02T12:00:00Z"));
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock,
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  it("allows exited (inactive) members to view their own history, and blocks cross-member queries", async () => {
    const exited = await makeMember(t.db, {
      id: "mem_exited",
      status: "inactive",
      displayName: "Exited Member",
    });
    const other = await makeMember(t.db, {
      id: "mem_other",
      status: "active",
      displayName: "Other Member",
    });
    const admin = await makeMember(t.db, {
      id: "mem_admin",
      role: "admin",
      status: "active",
      displayName: "Admin",
    });
    const pending = await makeMember(t.db, {
      id: "mem_pending",
      status: "pending",
      displayName: "Pending",
    });

    await t.db.insert(event).values({
      id: "evt_1",
      kind: "admin_oneoff",
      createdBy: admin.id,
      title: "Thursday XD",
      format: "XD",
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      location: "Hall A",
      capacity: 12,
      adhocFee: 120,
      maxGuestsPerMember: 1,
      rsvpCloseAt: RSVP_CLOSE_AT,
      allocationMode: "tiered",
      status: "closed",
      shareSlug: "thu-xd",
      closedProcessedAt: RSVP_CLOSE_AT,
    });

    await t.db.insert(rsvp).values([
      {
        id: "rsvp_exited",
        eventId: "evt_1",
        memberId: exited.id,
        status: "confirmed",
        tier: 2,
        requestedAt: new Date("2027-03-30T10:00:00Z"),
        confirmedAt: RSVP_CLOSE_AT,
        attendance: "attended",
      },
      {
        id: "rsvp_other",
        eventId: "evt_1",
        memberId: other.id,
        status: "confirmed",
        tier: 2,
        requestedAt: new Date("2027-03-30T10:05:00Z"),
        confirmedAt: RSVP_CLOSE_AT,
        attendance: "no_show",
      },
    ]);

    const res = await getHistory(exited.clerkUserId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ eventId: string; rsvp: { id: string } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.eventId).toBe("evt_1");
    expect(body.items[0]?.rsvp.id).toBe("rsvp_exited");

    // Own data only — even an admin cannot query another member's history.
    const crossByMember = await getHistory(exited.clerkUserId, `?memberId=${other.id}`);
    expect(crossByMember.status).toBe(403);

    const crossByAdmin = await getHistory(admin.clerkUserId, `?memberId=${exited.id}`);
    expect(crossByAdmin.status).toBe(403);

    // Pending member is rejected.
    const pendingRes = await getHistory(pending.clerkUserId);
    expect(pendingRes.status).toBe(403);
  });

  it("links every event-tied ledger row to its attendance & why history in both directions", async () => {
    const admin = await makeMember(t.db, {
      id: "mem_admin",
      role: "admin",
      displayName: "Admin",
    });
    const m = await makeMember(t.db, {
      id: "mem_1",
      displayName: "Alex",
    });

    await t.db.insert(term).values({
      id: "trm_1",
      name: "Spring 2027",
      startsOn: "2027-01-01",
      endsOn: "2027-06-30",
      status: "active",
    });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "trm_1",
      name: "Thursday XD",
      format: "XD",
      weekday: 4,
      startTime: "18:00",
      durationMin: 90,
      location: "Hall A",
      capacity: 12,
      passPrice: 1200,
      adhocFee: 120,
      maxGuestsDefault: 1,
      shareSlug: "thu-xd",
      passCap: 10,
    });
    await t.db.insert(pass).values({
      id: "pass_1",
      memberId: m.id,
      seriesId: "ser_1",
      priceCharged: 1200,
      eventsCovered: 12,
      status: "active",
    });

    // Event 1: prepaid series event with a guest (member is tier 1 no_show, guest is charged 120 kr)
    await t.db.insert(event).values({
      id: "evt_prepaid",
      seriesId: "ser_1",
      kind: "series",
      createdBy: admin.id,
      title: "Thu XD #1",
      format: "XD",
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      location: "Hall A",
      capacity: 12,
      adhocFee: 120,
      maxGuestsPerMember: 1,
      rsvpCloseAt: RSVP_CLOSE_AT,
      allocationMode: "tiered",
      status: "scheduled",
      shareSlug: "thu-xd-1",
    });
    await t.db.insert(rsvp).values({
      id: "rsvp_1",
      eventId: "evt_prepaid",
      memberId: m.id,
      status: "confirmed",
      tier: 1,
      requestedAt: new Date("2027-03-30T10:00:00Z"),
      confirmedAt: new Date("2027-03-30T10:00:00Z"),
      attendance: "no_show",
    });
    await t.db.insert(guest).values({
      id: "gst_1",
      rsvpId: "rsvp_1",
      name: "Sam Guest",
      status: "requested",
      tier: 3,
      requestedAt: new Date("2027-03-30T10:01:00Z"),
    });

    await closeEvent(t.db, new FixedClock(new Date("2027-04-01T12:05:00Z")), "evt_prepaid");

    // Event 2: late-cancelled and refilled (charge + reversal -> net 0 kr)
    await t.db.insert(event).values({
      id: "evt_refilled",
      kind: "admin_oneoff",
      createdBy: admin.id,
      title: "Friday Open",
      format: "open",
      startsAt: new Date("2027-04-02T18:00:00Z"),
      endsAt: new Date("2027-04-02T19:30:00Z"),
      location: "Hall B",
      capacity: 8,
      adhocFee: 100,
      maxGuestsPerMember: 0,
      rsvpCloseAt: new Date("2027-04-02T12:00:00Z"),
      allocationMode: "tiered",
      status: "closed",
      shareSlug: "fri-open",
      closedProcessedAt: new Date("2027-04-02T12:00:00Z"),
    });
    await t.db.insert(rsvp).values({
      id: "rsvp_2",
      eventId: "evt_refilled",
      memberId: m.id,
      status: "late_cancelled",
      tier: 2,
      requestedAt: new Date("2027-04-01T10:00:00Z"),
      confirmedAt: new Date("2027-04-02T12:00:00Z"),
      cancelledAt: new Date("2027-04-02T13:00:00Z"),
      refilled: true,
    });
    const ledger = createLedgerService({ db: t.db, clock });
    const charge = await ledger.charge({
      memberId: m.id,
      amountSek: 100,
      reason: "adhoc",
      eventId: "evt_refilled",
      createdBy: admin.id,
      idempotencyKey: "close:evt_refilled:mem_1",
    });
    await ledger.reverse({
      entryId: charge.id,
      createdBy: admin.id,
      idempotencyKey: `refill:${charge.id}`,
      note: "Spot refilled",
    });

    const res = await getHistory(m.clerkUserId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        eventId: string;
        title: string;
        shareSlug: string;
        netChargedSek: number;
        why: string;
        rsvp: { status: string; attendance: string; effectiveAttendance: string | null } | null;
        guests: Array<{ id: string; name: string; status: string }>;
        ledgerEntries: Array<{ id: string; amountSek: number; guestId: string | null }>;
      }>;
    };

    // Newest event first
    expect(body.items.map((i) => i.eventId)).toEqual(["evt_refilled", "evt_prepaid"]);

    const refilledItem = body.items[0]!;
    expect(refilledItem.netChargedSek).toBe(0);
    expect(refilledItem.why.toLowerCase()).toContain("refill");
    expect(refilledItem.ledgerEntries).toHaveLength(2);
    expect(refilledItem.ledgerEntries.map((e) => e.amountSek)).toEqual([100, -100]);

    const prepaidItem = body.items[1]!;
    expect(prepaidItem.netChargedSek).toBe(120);
    expect(prepaidItem.rsvp?.attendance).toBe("no_show");
    expect(prepaidItem.rsvp?.effectiveAttendance).toBe("no_show");
    expect(prepaidItem.why.toLowerCase()).toContain("pass");
    expect(prepaidItem.guests).toHaveLength(1);
    expect(prepaidItem.guests[0]?.name).toBe("Sam Guest");
    expect(prepaidItem.ledgerEntries).toHaveLength(1);
    expect(prepaidItem.ledgerEntries[0]?.guestId).toBe("gst_1");
    expect(prepaidItem.ledgerEntries[0]?.amountSek).toBe(120);
  });
});
