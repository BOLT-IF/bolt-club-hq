import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clubSettings,
  event,
  guest,
  ledgerEntry,
  notification,
  rsvp,
  series,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { configureEventsDeps } from "../events/deps";
import { createEvent } from "../events/model";
import { createLedgerService } from "../ledger/service";
import { requestIdMiddleware } from "../ops/logging";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePrepaid, FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { closeEvent } from "./close";
import { configureRsvpDeps } from "./deps";
import postcloseRoutes from "./postclose";
import rsvpRoutes from "./routes";

const NOW = "2027-04-01T12:00:00Z";
const HOUR = 3_600_000;
const MIN = 60_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("post-close RSVP, cancel, promotion, refill (S4.4a)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", rsvpRoutes)
      .route("/", postcloseRoutes);

  const send = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    clerkUserId: string,
    opts: { body?: unknown; key?: string } = {},
  ) => {
    const headers: Record<string, string> = { [TEST_IDENTITY_HEADER]: clerkUserId };
    if (method !== "GET") {
      headers["Idempotency-Key"] = opts.key ?? `k${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return app().request(path, init, testEnv);
  };

  const putPre = (eventId: string, clerk: string, guests: string[] = []) =>
    send("PUT", `/events/${eventId}/rsvp`, clerk, { body: { guests } });

  const delPre = (eventId: string, clerk: string) =>
    send("DELETE", `/events/${eventId}/rsvp`, clerk);

  const putLate = (eventId: string, clerk: string, guests: string[] = []) =>
    send("PUT", `/events/${eventId}/rsvp/late`, clerk, { body: { guests } });

  const lateCancel = (eventId: string, clerk: string, guestId?: string) =>
    send("POST", `/events/${eventId}/rsvp/late-cancel`, clerk, {
      body: guestId ? { guestId } : {},
    });

  async function seedSeries() {
    await t.db
      .insert(term)
      .values({
        id: "term_1",
        name: "Spring 2027",
        startsOn: "2027-01-01",
        endsOn: "2027-06-30",
        status: "active",
      })
      .onConflictDoNothing();
    await t.db
      .insert(series)
      .values({
        id: "ser_1",
        termId: "term_1",
        name: "Thursday Mixed",
        format: "mixed",
        weekday: 4,
        startTime: "19:00",
        durationMin: 90,
        location: "Hall X",
        capacity: 16,
        passPrice: 1000,
        adhocFee: 120,
        maxGuestsDefault: 2,
        rsvpCloseOffsetMin: 1440,
        shareSlug: "ser-1",
        passCap: 12,
      })
      .onConflictDoNothing();
  }

  async function addEvent(over: Partial<Parameters<typeof createEvent>[1]> = {}) {
    await seedSeries();
    const admin = await makeMember(t.db, { role: "admin" });
    return createEvent(
      { db: t.db, clock, publishOg: new FakePublishOg() },
      {
        seriesId: "ser_1",
        kind: "series",
        createdBy: admin.id,
        title: "Thu Session",
        format: "mixed",
        startsAt: at(48),
        endsAt: at(49.5),
        location: "Hall X",
        capacity: 4,
        adhocFee: 120,
        maxGuestsPerMember: 2,
        rsvpCloseAt: at(24),
        allocationMode: "tiered",
        ...over,
      },
    );
  }

  async function balanceOf(memberId: string) {
    return createLedgerService({ db: t.db, clock }).balance(memberId);
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    prepaid = new FakePrepaid();
    keySeq = 0;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureRsvpDeps({ prepaid: () => prepaid });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpDeps({});
    configureEventsDeps({});
    await t.cleanup();
  });

  describe("PLAN §6.4 charging table", () => {
    it("row 1: confirmed at/after close (paid event) -> prepaid 0, non-prepaid fee, guest fee", async () => {
      const ev = await addEvent({ capacity: 6, adhocFee: 120 });
      const passHolder = await makeMember(t.db);
      const adhoc = await makeMember(t.db);
      const lateMember = await makeMember(t.db);
      prepaid.grant(passHolder.id, ev.id);

      await putPre(ev.id, passHolder.clerkUserId, ["PassGuest"]);
      await putPre(ev.id, adhoc.clerkUserId);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      const res = await putLate(ev.id, lateMember.clerkUserId, ["LateGuest"]);
      expect(res.status).toBe(200);

      expect(await balanceOf(passHolder.id)).toBe(120); // 0 for self + 120 for PassGuest
      expect(await balanceOf(adhoc.id)).toBe(120);
      expect(await balanceOf(lateMember.id)).toBe(240); // 120 for self + 120 for LateGuest
    });

    it("row 2: cancel before close -> prepaid 0, non-prepaid 0, guest 0", async () => {
      const ev = await addEvent({ capacity: 4, adhocFee: 120 });
      const passHolder = await makeMember(t.db);
      const adhoc = await makeMember(t.db);
      prepaid.grant(passHolder.id, ev.id);

      await putPre(ev.id, passHolder.clerkUserId, ["G1"]);
      await putPre(ev.id, adhoc.clerkUserId, ["G2"]);
      await delPre(ev.id, passHolder.clerkUserId);
      await delPre(ev.id, adhoc.clerkUserId);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      expect(await balanceOf(passHolder.id)).toBe(0);
      expect(await balanceOf(adhoc.id)).toBe(0);
    });

    it("row 3: late cancel, refilled -> prepaid 0, non-prepaid reversed, guest reversed", async () => {
      const ev = await addEvent({ capacity: 3, adhocFee: 120 });
      const passHolder = await makeMember(t.db);
      const adhoc = await makeMember(t.db);
      const replacer1 = await makeMember(t.db);
      const replacer2 = await makeMember(t.db);
      const replacer3 = await makeMember(t.db);
      prepaid.grant(passHolder.id, ev.id);

      await putPre(ev.id, passHolder.clerkUserId);
      await putPre(ev.id, adhoc.clerkUserId, ["GuestA"]);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      // Event is full (3/3). Both cancel, freeing 3 spots.
      await lateCancel(ev.id, passHolder.clerkUserId);
      await lateCancel(ev.id, adhoc.clerkUserId);

      // 3 replacements fill all 3 spots.
      await putLate(ev.id, replacer1.clerkUserId);
      await putLate(ev.id, replacer2.clerkUserId);
      await putLate(ev.id, replacer3.clerkUserId);

      expect(await balanceOf(passHolder.id)).toBe(0);
      expect(await balanceOf(adhoc.id)).toBe(0); // both adhoc and GuestA reversed
    });

    it("row 4: late cancel, not refilled -> prepaid 0, non-prepaid stands, guest stands", async () => {
      const ev = await addEvent({ capacity: 3, adhocFee: 120 });
      const passHolder = await makeMember(t.db);
      const adhoc = await makeMember(t.db);
      prepaid.grant(passHolder.id, ev.id);

      await putPre(ev.id, passHolder.clerkUserId);
      await putPre(ev.id, adhoc.clerkUserId, ["GuestA"]);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      await lateCancel(ev.id, passHolder.clerkUserId);
      await lateCancel(ev.id, adhoc.clerkUserId);

      expect(await balanceOf(passHolder.id)).toBe(0);
      expect(await balanceOf(adhoc.id)).toBe(240); // 120 self + 120 guest stand
    });

    it("row 5: no-show (confirmed, never cancelled) -> prepaid 0, non-prepaid stands, guest stands", async () => {
      const ev = await addEvent({ capacity: 4, adhocFee: 120 });
      const passHolder = await makeMember(t.db);
      const adhoc = await makeMember(t.db);
      prepaid.grant(passHolder.id, ev.id);

      await putPre(ev.id, passHolder.clerkUserId);
      await putPre(ev.id, adhoc.clerkUserId, ["GuestA"]);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      expect(await balanceOf(passHolder.id)).toBe(0);
      expect(await balanceOf(adhoc.id)).toBe(240);
    });

    it("row 6: admin paid one-off -> everyone confirmed pays fee (no tier 1), including guests", async () => {
      const ev = await addEvent({
        kind: "admin_oneoff",
        seriesId: null,
        capacity: 4,
        adhocFee: 150,
      });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      prepaid.grant(m1.id, ev.id); // ignored on admin_oneoff

      await putPre(ev.id, m1.clerkUserId);
      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      await putLate(ev.id, m2.clerkUserId, ["G1"]);
      expect(await balanceOf(m1.id)).toBe(150);
      expect(await balanceOf(m2.id)).toBe(300);
    });

    it("row 7: member one-off -> 0 ledger entries", async () => {
      const ev = await addEvent({
        kind: "member_oneoff",
        seriesId: null,
        allocationMode: "instant",
        capacity: 2,
        adhocFee: 0,
      });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      await putPre(ev.id, m1.clerkUserId);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      await putLate(ev.id, m2.clerkUserId);
      await lateCancel(ev.id, m1.clerkUserId);

      const entries = await t.db.select().from(ledgerEntry).where(eq(ledgerEntry.eventId, ev.id));
      expect(entries).toHaveLength(0);
    });
  });

  describe("tests first: core invariants", () => {
    it("cancelling while spots are free means the charge stands", async () => {
      const ev = await addEvent({ capacity: 4, adhocFee: 120 });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);
      const late = await makeMember(t.db);

      await putPre(ev.id, m1.clerkUserId);
      await putPre(ev.id, m2.clerkUserId);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      // 2/4 confirmed -> 2 spots are free when m1 cancels.
      const cancelRes = await lateCancel(ev.id, m1.clerkUserId);
      expect(cancelRes.status).toBe(200);

      // Another member joins (now 2/4 confirmed, still spots free).
      await putLate(ev.id, late.clerkUserId);

      expect(await balanceOf(m1.id)).toBe(120);
    });

    it("with two late cancels and one refill, the earliest cancel is reversed", async () => {
      const ev = await addEvent({ capacity: 2, adhocFee: 120 });
      const first = await makeMember(t.db);
      const second = await makeMember(t.db);
      const replacer = await makeMember(t.db);

      await putPre(ev.id, first.clerkUserId);
      await putPre(ev.id, second.clerkUserId);

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      clock.set(at(26));
      await lateCancel(ev.id, first.clerkUserId);
      clock.set(at(27));
      await lateCancel(ev.id, second.clerkUserId);

      clock.set(at(28));
      await putLate(ev.id, replacer.clerkUserId);

      expect(await balanceOf(first.id)).toBe(0);
      expect(await balanceOf(second.id)).toBe(120);
      expect(await balanceOf(replacer.id)).toBe(120);
    });

    it("a host cancel cascades to their guests", async () => {
      const ev = await addEvent({ capacity: 4, adhocFee: 120 });
      const host = await makeMember(t.db);

      await putPre(ev.id, host.clerkUserId, ["Guest 1", "Guest 2"]);
      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      const res = await lateCancel(ev.id, host.clerkUserId);
      expect(res.status).toBe(200);

      const [rsvpRow] = await t.db.select().from(rsvp).where(eq(rsvp.eventId, ev.id));
      const guestRows = await t.db.select().from(guest).where(eq(guest.rsvpId, rsvpRow!.id));
      expect(rsvpRow!.status).toBe("late_cancelled");
      expect(guestRows.every((g) => g.status === "late_cancelled")).toBe(true);
    });

    it("a promoted member who then cancels is a late cancel", async () => {
      const ev = await addEvent({ capacity: 1, adhocFee: 120 });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);

      await putPre(ev.id, m1.clerkUserId);
      clock.advance(1000);
      await putPre(ev.id, m2.clerkUserId); // waitlisted

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      // Before cutoff (48h - 3h = 45h): m1 cancels -> m2 is auto-promoted and charged 120.
      clock.set(at(26));
      await lateCancel(ev.id, m1.clerkUserId);

      const [m2RsvpBefore] = await t.db.select().from(rsvp).where(eq(rsvp.memberId, m2.id));
      expect(m2RsvpBefore!.status).toBe("confirmed");
      expect(await balanceOf(m2.id)).toBe(120);
      // m1 was refilled by m2!
      expect(await balanceOf(m1.id)).toBe(0);

      // Now promoted m2 cancels -> late cancel, charge stands!
      clock.set(at(27));
      const res = await lateCancel(ev.id, m2.clerkUserId);
      expect(res.status).toBe(200);

      const [m2RsvpAfter] = await t.db.select().from(rsvp).where(eq(rsvp.memberId, m2.id));
      expect(m2RsvpAfter!.status).toBe("late_cancelled");
      expect(await balanceOf(m2.id)).toBe(120);
    });

    it("a guest added after close is tier 3", async () => {
      const ev = await addEvent({ capacity: 1, adhocFee: 120 });
      const host = await makeMember(t.db);
      prepaid.grant(host.id, ev.id);

      await putPre(ev.id, host.clerkUserId);
      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      const res = await putLate(ev.id, host.clerkUserId, ["Late Guest"]);
      expect(res.status).toBe(200);
      const body = await res.json<{
        rsvp: { status: string; guests: Array<{ name: string; status: string }> };
      }>();
      expect(body.rsvp.status).toBe("confirmed");
      expect(body.rsvp.guests).toHaveLength(1);
      expect(body.rsvp.guests[0]!.status).toBe("waitlisted");

      const [g] = await t.db.select().from(guest);
      expect(g!.tier).toBe(3);
      expect(g!.status).toBe("waitlisted");
    });

    it("stops auto-promotion at cutoff and offers spot to waitlisted members instead", async () => {
      await t.db
        .insert(clubSettings)
        .values({ id: 1, clubName: "BOLT", autoPromoteCutoffMin: 180 })
        .onConflictDoNothing();
      const ev = await addEvent({ capacity: 1, adhocFee: 120 });
      const m1 = await makeMember(t.db);
      const m2 = await makeMember(t.db);

      await putPre(ev.id, m1.clerkUserId);
      clock.advance(1000);
      await putPre(ev.id, m2.clerkUserId); // waitlisted

      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      // Inside 3h cutoff (startsAt is at(48), so at(46) is 2h before start).
      clock.set(at(46));
      await lateCancel(ev.id, m1.clerkUserId);

      const [m2Rsvp] = await t.db.select().from(rsvp).where(eq(rsvp.memberId, m2.id));
      expect(m2Rsvp!.status).toBe("offered");
      expect(await balanceOf(m2.id)).toBe(0);
      expect(await balanceOf(m1.id)).toBe(120); // not refilled yet

      const notifs = await t.db
        .select()
        .from(notification)
        .where(eq(notification.memberId, m2.id));
      expect(notifs.some((n) => n.category === "rsvp_status")).toBe(true);
    });

    it("prepaid late RSVP when full joins top of waitlist without bumping confirmed", async () => {
      const ev = await addEvent({ capacity: 1, adhocFee: 120 });
      const confirmed = await makeMember(t.db);
      const latePrepaid = await makeMember(t.db);
      prepaid.grant(latePrepaid.id, ev.id);

      await putPre(ev.id, confirmed.clerkUserId);
      clock.set(at(25));
      await closeEvent(t.db, clock, ev.id);

      const res = await putLate(ev.id, latePrepaid.clerkUserId);
      expect(res.status).toBe(200);
      const body = await res.json<{ rsvp: { status: string; tier: number } }>();
      expect(body.rsvp.status).toBe("waitlisted");
      expect(body.rsvp.tier).toBe(1);

      const [cRsvp] = await t.db.select().from(rsvp).where(eq(rsvp.memberId, confirmed.id));
      expect(cRsvp!.status).toBe("confirmed");
    });
  });
});
