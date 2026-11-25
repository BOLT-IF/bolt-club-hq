/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- response bodies are asserted field by field. */
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  auditLog,
  clubSettings,
  domainEventOutbox,
  ledgerEntry,
  member as memberTable,
  notification,
  pass,
  rsvp,
  series,
  seriesDiscountEligible,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createEvent } from "../events/model";
import { createLedgerService } from "../ledger/service";
import { requestIdMiddleware } from "../ops/logging";
import { configureRsvpDeps } from "../rsvp/deps";
import rsvpRoutes from "../rsvp/routes";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import passesRoutes from "./routes";

const NOW = "2027-03-01T10:00:00Z";
const DAY_MS = 86_400_000;
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

type Member = Awaited<ReturnType<typeof makeMember>>;

describe("passes routes (S5.3)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let admin: Member;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", passesRoutes)
      .route("/", rsvpRoutes);

  async function call(
    as: Member | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; key?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    if (method !== "GET" && opts.key !== null) {
      headers["Idempotency-Key"] = opts.key ?? `k_${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await app().request(path, init, testEnv);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test response bodies are loosely typed
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  async function seedSeriesWithDates(opts: {
    termId?: string;
    termStatus?: "draft" | "open_for_passes" | "active" | "closed";
    startsOn?: string;
    endsOn?: string;
    seriesId?: string;
    passPrice?: number;
    capacity?: number;
    passCap?: number;
    eventDates?: Array<{
      date: string;
      status?: "scheduled" | "closed" | "cancelled" | "completed";
    }>;
  }) {
    const termId = opts.termId ?? "term_1";
    const seriesId = opts.seriesId ?? "ser_1";
    await t.db.insert(term).values({
      id: termId,
      name: "Spring 2027",
      startsOn: opts.startsOn ?? "2027-03-04",
      endsOn: opts.endsOn ?? "2027-03-25",
      status: opts.termStatus ?? "open_for_passes",
    });
    const capacity = opts.capacity ?? 4;
    await t.db.insert(series).values({
      id: seriesId,
      termId,
      name: "Thursday XD",
      format: "XD",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      location: "Hall A",
      capacity,
      passPrice: opts.passPrice ?? 1000,
      adhocFee: 120,
      maxGuestsDefault: 1,
      rsvpCloseOffsetMin: 1440,
      shareSlug: `slug-${seriesId}`,
      skipDatesLocked: true,
      passCap: opts.passCap ?? capacity,
    });
    const createdEvents = [];
    for (const item of opts.eventDates ?? []) {
      const startsAt = new Date(`${item.date}T18:00:00Z`);
      const endsAt = new Date(`${item.date}T19:30:00Z`);
      const rsvpCloseAt = new Date(`${item.date}T18:00:00Z`);
      rsvpCloseAt.setUTCDate(rsvpCloseAt.getUTCDate() - 1);
      const ev = await createEvent(
        { db: t.db, clock, publishOg: new FakePublishOg() },
        {
          seriesId,
          kind: "series",
          createdBy: admin.id,
          title: "Thursday XD",
          format: "XD",
          startsAt,
          endsAt,
          location: "Hall A",
          capacity,
          adhocFee: 120,
          maxGuestsPerMember: 1,
          rsvpCloseAt,
          allocationMode: "tiered",
          status: item.status ?? "scheduled",
        },
      );
      createdEvents.push(ev);
    }
    return { termId, seriesId, events: createdEvents };
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    // Intentionally reset rsvpDeps to production default (real isPrepaid, no fake!).
    configureRsvpDeps({});
    admin = await makeMember(t.db, { role: "admin" });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpDeps({});
    await t.close();
  });

  describe("offers & proration", () => {
    it("offers active/open_for_passes series with prorated half-up price, and hides 0-remaining or draft/closed", async () => {
      const member = await makeMember(t.db);
      // 4 Thursdays in 2027-03: 04, 11, 18, 25. Advance clock so 04 and 11 are closed (2 remain).
      await seedSeriesWithDates({
        termId: "t_open",
        termStatus: "active",
        seriesId: "s_open",
        passPrice: 101,
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }],
      });
      // Draft term: never offered.
      await seedSeriesWithDates({
        termId: "t_draft",
        termStatus: "draft",
        seriesId: "s_draft",
        startsOn: "2027-04-01",
        endsOn: "2027-04-08",
        eventDates: [{ date: "2027-04-01" }, { date: "2027-04-08" }],
      });
      // Past series with 0 remaining events: not offered.
      await seedSeriesWithDates({
        termId: "t_empty",
        termStatus: "active",
        seriesId: "s_empty",
        startsOn: "2027-02-04",
        endsOn: "2027-02-11",
        eventDates: [{ date: "2027-02-04" }, { date: "2027-02-11" }],
      });

      // Move clock to 2027-03-04T12:00Z (after 03-04 close on 03-03T18:00Z, before 03-11 close).
      clock.set("2027-03-04T12:00:00Z");

      const res = await call(member, "GET", "/passes/offers");
      expect(res.status).toBe(200);
      expect(res.body.offers).toHaveLength(1);
      expect(res.body.offers[0]).toMatchObject({
        seriesId: "s_open",
        passPrice: 101,
        priceSek: 51, // round_half_up(101 * 1 / 2)
        remainingEvents: 1,
        totalEvents: 2,
        termsNotice: "Covers up to 1 sessions; no refunds; cancelled nights not compensated.",
      });

      // Move past the last close: 0 remaining -> not offered.
      clock.set("2027-03-10T18:00:00Z");
      const none = await call(member, "GET", "/passes/offers");
      expect(none.status).toBe(200);
      expect(none.body.offers).toHaveLength(0);
    });

    it("excludes cancelled events from remainingEvents and rejects purchase when 0 remain", async () => {
      const member = await makeMember(t.db);
      await seedSeriesWithDates({
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [
          { date: "2027-03-04", status: "cancelled" },
          { date: "2027-03-11", status: "cancelled" },
        ],
      });

      const offers = await call(member, "GET", "/passes/offers");
      expect(offers.status).toBe(200);
      expect(offers.body.offers).toHaveLength(0);

      const buy = await call(member, "POST", "/passes", { body: { seriesId: "ser_1" } });
      expect(buy.status).toBe(409);
      expect(buy.body.error).toBe("no_events_remaining");
    });
  });

  describe("cap concurrency & purchase transaction", () => {
    it("two buyers for one remaining seat: exactly one succeeds", async () => {
      const [m1, m2] = [await makeMember(t.db), await makeMember(t.db)];
      await seedSeriesWithDates({
        capacity: 4,
        passCap: 1,
        passPrice: 1200,
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }],
      });

      const [r1, r2] = await Promise.all([
        call(m1, "POST", "/passes", { body: { seriesId: "ser_1" } }),
        call(m2, "POST", "/passes", { body: { seriesId: "ser_1" } }),
      ]);

      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      expect(loser.body.error).toBe("pass_cap_reached");

      const passes = await t.db.select().from(pass).where(eq(pass.seriesId, "ser_1"));
      expect(passes).toHaveLength(1);
      expect(passes[0]!.status).toBe("active");

      const charges = await t.db
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.passId, passes[0]!.id));
      expect(charges).toHaveLength(1);
      expect(charges[0]!.amountSek).toBe(1200);
      expect(charges[0]!.reason).toBe("pass");
    });

    it("keeps inactive (exited) member's pass seat occupied so it cannot be resold (PLAN §6.7)", async () => {
      const [exited, newcomer] = [await makeMember(t.db), await makeMember(t.db)];
      await seedSeriesWithDates({
        capacity: 4,
        passCap: 1,
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }],
      });

      expect((await call(exited, "POST", "/passes", { body: { seriesId: "ser_1" } })).status).toBe(
        201,
      );
      await t.db
        .update(memberTable)
        .set({ status: "inactive" })
        .where(eq(memberTable.id, exited.id));

      const blocked = await call(newcomer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("pass_cap_reached");
    });

    it("buying a pass upgrades open series RSVPs from requested to confirmed (tier 1), emits rsvp_changed, and wires real isPrepaid", async () => {
      const buyer = await makeMember(t.db);
      const { events } = await seedSeriesWithDates({
        startsOn: "2027-03-04",
        endsOn: "2027-03-18",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }, { date: "2027-03-18" }],
      });
      const oneoff = await createEvent(
        { db: t.db, clock, publishOg: new FakePublishOg() },
        {
          seriesId: null,
          kind: "admin_oneoff",
          createdBy: admin.id,
          title: "One-off Open",
          format: "open",
          startsAt: new Date("2027-03-20T18:00:00Z"),
          endsAt: new Date("2027-03-20T19:30:00Z"),
          capacity: 8,
          adhocFee: 150,
          maxGuestsPerMember: 1,
          rsvpCloseAt: new Date("2027-03-19T18:00:00Z"),
          allocationMode: "tiered",
        },
      );

      // Before buying: RSVP to event 0, event 1, and the admin one-off -> all requested tier 2.
      const r0 = await call(buyer, "PUT", `/events/${events[0]!.id}/rsvp`, {
        body: { guests: ["Kim"] },
      });
      const r1 = await call(buyer, "PUT", `/events/${events[1]!.id}/rsvp`, { body: {} });
      const ro = await call(buyer, "PUT", `/events/${oneoff.id}/rsvp`, { body: {} });
      expect(r0.body.rsvp).toMatchObject({ status: "requested", tier: 2 });
      expect(r1.body.rsvp).toMatchObject({ status: "requested", tier: 2 });
      expect(ro.body.rsvp).toMatchObject({ status: "requested", tier: 2 });

      // Advance past event 0's close so only event 1 (and un-RSVPed event 2) remain open!
      clock.set("2027-03-04T12:00:00Z");

      const buy = await call(buyer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      expect(buy.status).toBe(201);
      expect(buy.body.upgradedRsvps).toBe(1);

      // Event 1 upgraded to confirmed tier 1; event 0 (past rsvpCloseAt) and one-off stay requested tier 2.
      // Read event 0's RSVP row directly so S4.3 close-on-read via GET doesn't close & confirm it.
      const [rsvp0] = await t.db
        .select()
        .from(rsvp)
        .where(and(eq(rsvp.eventId, events[0]!.id), eq(rsvp.memberId, buyer.id)));
      const g1 = await call(buyer, "GET", `/events/${events[1]!.id}/rsvp`);
      const go = await call(buyer, "GET", `/events/${oneoff.id}/rsvp`);
      expect(rsvp0).toMatchObject({ status: "requested", tier: 2 });
      expect(g1.body.rsvp).toMatchObject({ status: "confirmed", tier: 1 });
      expect(go.body.rsvp).toMatchObject({ status: "requested", tier: 2 });

      // Outbox recorded rsvp_changed for the upgrade.
      const outbox = await t.db
        .select()
        .from(domainEventOutbox)
        .where(eq(domainEventOutbox.type, "rsvp_changed"))
        .orderBy(asc(domainEventOutbox.createdAt));
      expect(
        outbox.some(
          (row) =>
            (row.payload as { eventId: string }).eventId === events[1]!.id &&
            (row.payload as { status: string }).status === "confirmed" &&
            (row.payload as { tier: number }).tier === 1,
        ),
      ).toBe(true);

      // Real isPrepaid (production default, no fake!) confirms a new RSVP on event 2 as tier 1.
      const r2 = await call(buyer, "PUT", `/events/${events[2]!.id}/rsvp`, { body: {} });
      expect(r2.status).toBe(200);
      expect(r2.body.rsvp).toMatchObject({ status: "confirmed", tier: 1 });
    });
  });

  describe("revocation & no refund path", () => {
    it("is gated on N days from clubSettings and pass charge still unpaid (FIFO)", async () => {
      const buyer = await makeMember(t.db);
      const otherBuyer = await makeMember(t.db);
      const { events } = await seedSeriesWithDates({
        passCap: 1,
        passPrice: 900,
        startsOn: "2027-03-04",
        endsOn: "2027-05-27",
        eventDates: [{ date: "2027-04-01" }, { date: "2027-04-08" }, { date: "2027-04-15" }],
      });
      await t.db.insert(clubSettings).values({
        id: 1,
        clubName: "BOLT IF",
        passUnpaidRevokeDays: 14,
      });

      const buy = await call(buyer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      expect(buy.status).toBe(201);
      const passId = buy.body.pass.id as string;

      // Member RSVPs to two future series events -> confirmed tier 1.
      await call(buyer, "PUT", `/events/${events[0]!.id}/rsvp`, { body: {} });
      await call(buyer, "PUT", `/events/${events[1]!.id}/rsvp`, { body: {} });

      // Day 13: too early to revoke.
      clock.set(new Date(new Date(NOW).getTime() + 13 * DAY_MS));
      const listEarly = await call(admin, "GET", "/admin/passes");
      expect(listEarly.status).toBe(200);
      expect(listEarly.body.passes[0]).toMatchObject({ id: passId, revocable: false });

      const early = await call(admin, "POST", `/admin/passes/${passId}/revoke`, { body: {} });
      expect(early.status).toBe(409);
      expect(early.body.error).toBe("revoke_too_early");

      // Day 14: now eligible! Advance past event 0's close too, so only event 1 is open before close.
      clock.set("2027-04-01T12:00:00Z"); // 31 days after NOW, after event 0 close (03-31T18Z), before event 1 close (04-07T18Z).
      const listReady = await call(admin, "GET", "/admin/passes");
      expect(listReady.body.passes[0]).toMatchObject({
        id: passId,
        revocable: true,
        unpaidSek: 900,
      });

      // Non-admin cannot revoke.
      expect(
        (await call(buyer, "POST", `/admin/passes/${passId}/revoke`, { body: {} })).status,
      ).toBe(403);

      const revoked = await call(admin, "POST", `/admin/passes/${passId}/revoke`, {
        body: {},
        key: "rev-1",
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.pass.status).toBe("revoked");
      expect(revoked.body.downgradedRsvps).toBe(1);

      // Replayed idempotent request returns 200 without duplicating effects.
      const replay = await call(admin, "POST", `/admin/passes/${passId}/revoke`, {
        body: {},
        key: "rev-1",
      });
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");

      // A second distinct key gets 409 pass_already_revoked.
      const second = await call(admin, "POST", `/admin/passes/${passId}/revoke`, { body: {} });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("pass_already_revoked");

      // Ledger: pass charge was reversed with reason "revocation"; net balance is 0.
      const ledger = createLedgerService({ db: t.db, clock });
      expect(await ledger.balance(buyer.id)).toBe(0);
      const entries = await t.db
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.memberId, buyer.id));
      expect(entries.some((e) => e.kind === "reversal" && e.reason === "revocation")).toBe(true);

      // Seat was freed: another buyer can now buy the remaining pass!
      const nextBuy = await call(otherBuyer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      expect(nextBuy.status).toBe(201);

      // Open future RSVP (event 1) downgraded to requested tier 2; closed event 0 untouched.
      const [r0] = await t.db
        .select()
        .from(rsvp)
        .where(and(eq(rsvp.eventId, events[0]!.id), eq(rsvp.memberId, buyer.id)));
      const [r1] = await t.db
        .select()
        .from(rsvp)
        .where(and(eq(rsvp.eventId, events[1]!.id), eq(rsvp.memberId, buyer.id)));
      expect(r0!.status).toBe("confirmed");
      expect(r1).toMatchObject({ status: "requested", tier: 2, confirmedAt: null });

      // New RSVP by revoked member is tier 2 requested.
      const r2 = await call(buyer, "PUT", `/events/${events[2]!.id}/rsvp`, { body: {} });
      expect(r2.body.rsvp).toMatchObject({ status: "requested", tier: 2 });

      // Member was notified.
      const notifs = await t.db
        .select()
        .from(notification)
        .where(eq(notification.memberId, buyer.id));
      expect(notifs).toHaveLength(1);
      expect(notifs[0]!.category).toBe("payment_status");

      // Audit recorded pass.revoke.
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entity, "pass"), eq(auditLog.entityId, passId)));
      expect(audits.some((a) => a.action === "pass.revoke")).toBe(true);
    });

    it("refuses revocation when the pass charge has been paid (FIFO), and has no refund path", async () => {
      const buyer = await makeMember(t.db);
      await seedSeriesWithDates({
        passPrice: 900,
        startsOn: "2027-03-04",
        endsOn: "2027-04-08",
        eventDates: [{ date: "2027-04-01" }, { date: "2027-04-08" }],
      });

      const buy = await call(buyer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      const passId = buy.body.pass.id as string;

      const ledger = createLedgerService({ db: t.db, clock });
      await ledger.recordPayment({
        memberId: buyer.id,
        amountSek: 900,
        actor: { ...admin, seriesIds: [] },
        idempotencyKey: "pay-full-1",
      });

      // Advance past 21 default days.
      clock.set(new Date(new Date(NOW).getTime() + 25 * DAY_MS));

      const list = await call(admin, "GET", "/admin/passes");
      expect(list.body.passes[0]).toMatchObject({
        id: passId,
        chargeStatus: "paid",
        revocable: false,
      });

      const rev = await call(admin, "POST", `/admin/passes/${passId}/revoke`, { body: {} });
      expect(rev.status).toBe(409);
      expect(rev.body.error).toBe("pass_already_paid");

      // No refund or member-cancel endpoints exist.
      expect((await call(buyer, "DELETE", `/passes/${passId}`)).status).toBe(404);
      expect((await call(buyer, "POST", `/passes/${passId}/refund`, { body: {} })).status).toBe(
        404,
      );
      expect((await call(buyer, "POST", `/passes/${passId}/cancel`, { body: {} })).status).toBe(
        404,
      );
    });

    it("allows revoking a partly paid pass after N days and leaves partial payment as credit", async () => {
      const buyer = await makeMember(t.db);
      await seedSeriesWithDates({
        passPrice: 900,
        startsOn: "2027-03-04",
        endsOn: "2027-04-08",
        eventDates: [{ date: "2027-04-01" }, { date: "2027-04-08" }],
      });
      const buy = await call(buyer, "POST", "/passes", { body: { seriesId: "ser_1" } });
      const passId = buy.body.pass.id as string;

      const ledger = createLedgerService({ db: t.db, clock });
      await ledger.recordPayment({
        memberId: buyer.id,
        amountSek: 300,
        actor: { ...admin, seriesIds: [] },
        idempotencyKey: "pay-part-1",
      });

      clock.set(new Date(new Date(NOW).getTime() + 25 * DAY_MS));
      const rev = await call(admin, "POST", `/admin/passes/${passId}/revoke`, { body: {} });
      expect(rev.status).toBe(200);
      expect(await ledger.balance(buyer.id)).toBe(-300);
    });

    it("applies the self-ledger guard on revocation when another active admin exists", async () => {
      const secondAdmin = await makeMember(t.db, { role: "admin" });
      await seedSeriesWithDates({
        passPrice: 800,
        startsOn: "2027-04-01",
        endsOn: "2027-04-08",
        eventDates: [{ date: "2027-04-01" }, { date: "2027-04-08" }],
      });
      const buy = await call(secondAdmin, "POST", "/passes", { body: { seriesId: "ser_1" } });
      const passId = buy.body.pass.id as string;

      clock.set(new Date(new Date(NOW).getTime() + 25 * DAY_MS));
      const selfRevoke = await call(secondAdmin, "POST", `/admin/passes/${passId}/revoke`, {
        body: {},
      });
      expect(selfRevoke.status).toBe(403);
      expect(selfRevoke.body.error).toBe("self_ledger_blocked");

      // The other admin can revoke it cleanly.
      const otherRevoke = await call(admin, "POST", `/admin/passes/${passId}/revoke`, {
        body: {},
      });
      expect(otherRevoke.status).toBe(200);
    });
  });

  describe("admin grant, guards & idempotency", () => {
    it("allows an admin to grant a comp pass (0 kr) and enforces active member & pass_cap", async () => {
      const m = await makeMember(t.db);
      await seedSeriesWithDates({
        passCap: 2,
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }],
      });
      const res = await call(admin, "POST", "/admin/passes", {
        body: { memberId: m.id, seriesId: "ser_1", priceSek: 0 },
      });
      expect(res.status).toBe(201);
      expect(res.body.pass).toMatchObject({
        memberId: m.id,
        seriesId: "ser_1",
        priceCharged: 0,
        grantedBy: admin.id,
      });
      expect(
        await t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, m.id)),
      ).toHaveLength(0);
    });

    it("enforces guards and Idempotency-Key on POST routes", async () => {
      const m = await makeMember(t.db);
      const pending = await makeMember(t.db, { status: "pending" });
      await seedSeriesWithDates({
        startsOn: "2027-03-04",
        endsOn: "2027-03-11",
        eventDates: [{ date: "2027-03-04" }, { date: "2027-03-11" }],
      });

      expect((await call(null, "GET", "/passes/offers")).status).toBe(401);
      expect((await call(pending, "GET", "/passes/offers")).status).toBe(403);
      expect((await call(m, "GET", "/admin/passes")).status).toBe(403);
      expect(
        (await call(m, "POST", "/passes", { body: { seriesId: "ser_1" }, key: null })).status,
      ).toBe(400);
      expect(
        (
          await call(admin, "POST", "/admin/passes", {
            body: { memberId: m.id, seriesId: "ser_1" },
            key: null,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(admin, "POST", "/admin/passes/pas_missing/revoke", {
            body: {},
            key: null,
          })
        ).status,
      ).toBe(400);

      // Double-tap purchase with the same key charges once.
      const first = await call(m, "POST", "/passes", { body: { seriesId: "ser_1" }, key: "dup-1" });
      const replay = await call(m, "POST", "/passes", {
        body: { seriesId: "ser_1" },
        key: "dup-1",
      });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await t.db.select().from(pass).where(eq(pass.memberId, m.id))).toHaveLength(1);
    });
  });

  describe("returning-subscriber discounted rate", () => {
    it("offers and charges discountedPassPrice only to eligible members", async () => {
      const returning = await makeMember(t.db, { displayName: "Returning" });
      const regular = await makeMember(t.db, { displayName: "Regular" });
      await seedSeriesWithDates({ passPrice: 1000 });
      await t.db.update(series).set({ discountedPassPrice: 700 }).where(eq(series.id, "ser_1"));
      await t.db
        .insert(seriesDiscountEligible)
        .values({ seriesId: "ser_1", memberId: returning.id });

      const returningOffers = (await call(returning, "GET", "/passes/offers")).body as {
        offers: Array<{ priceSek: number; regularPassPrice: number; discounted: boolean }>;
      };
      expect(returningOffers.offers[0]).toMatchObject({
        priceSek: 700,
        regularPassPrice: 1000,
        discounted: true,
      });

      const regularOffers = (await call(regular, "GET", "/passes/offers")).body as {
        offers: Array<{ priceSek: number; regularPassPrice: number; discounted: boolean }>;
      };
      expect(regularOffers.offers[0]).toMatchObject({
        priceSek: 1000,
        regularPassPrice: 1000,
        discounted: false,
      });

      const buyReturning = await call(returning, "POST", "/passes", {
        body: { seriesId: "ser_1" },
        key: "disc-1",
      });
      expect(buyReturning.status).toBe(201);
      expect((buyReturning.body as { pass: { priceCharged: number } }).pass.priceCharged).toBe(700);

      const buyRegular = await call(regular, "POST", "/passes", {
        body: { seriesId: "ser_1" },
        key: "reg-1",
      });
      expect(buyRegular.status).toBe(201);
      expect((buyRegular.body as { pass: { priceCharged: number } }).pass.priceCharged).toBe(1000);
    });
  });
});
