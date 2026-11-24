import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";

import { domainEventOutbox, guest, ledgerEntry, rsvp, series, term } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createEvent } from "../events/model";
import { requestIdMiddleware } from "../ops/logging";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePrepaid, FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { cancelMemberRsvps } from "./cancel";
import { configureRsvpDeps } from "./deps";
import rsvpRoutes from "./routes";

const NOW = "2027-03-10T12:00:00Z";
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);

interface RsvpDto {
  id: string;
  status: string;
  tier: number;
  guests: Array<{ id: string; name: string; status: string }>;
}

describe("rsvp routes (S4.2)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => new Date(NOW).getTime() }))
      .route("/", rsvpRoutes);

  const send = async (
    method: "GET" | "PUT" | "DELETE",
    eventId: string,
    clerkUserId: string,
    opts: { body?: unknown; key?: string | null } = {},
  ) => {
    const headers: Record<string, string> = { [TEST_IDENTITY_HEADER]: clerkUserId };
    if (method !== "GET" && opts.key !== null) {
      headers["Idempotency-Key"] = opts.key ?? `k${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return await app().request(`/events/${eventId}/rsvp`, init, testEnv);
  };
  const put = (eventId: string, clerk: string, body: unknown = {}, key?: string) =>
    send("PUT", eventId, clerk, key === undefined ? { body } : { body, key });
  const del = (eventId: string, clerk: string, key?: string) =>
    send("DELETE", eventId, clerk, key === undefined ? {} : { key });
  const json = (res: Response) => res.json<{ rsvp: RsvpDto | null }>();

  async function addEvent(over: Partial<Parameters<typeof createEvent>[1]> = {}) {
    const admin = await makeMember(t.db, { role: "admin" });
    return createEvent(
      { db: t.db, clock, publishOg: new FakePublishOg() },
      {
        seriesId: "ser_1",
        kind: "series",
        createdBy: admin.id,
        title: "Thu",
        format: "open",
        startsAt: at(48),
        endsAt: at(49.5),
        location: "Hall",
        capacity: 4,
        adhocFee: 120,
        maxGuestsPerMember: 2,
        rsvpCloseAt: at(24),
        allocationMode: "tiered",
        ...over,
      },
    );
  }
  const instantEvent = (capacity: number, maxGuests = 1) =>
    addEvent({
      kind: "member_oneoff",
      seriesId: null,
      allocationMode: "instant",
      adhocFee: 0,
      capacity,
      maxGuestsPerMember: maxGuests,
    });

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    prepaid = new FakePrepaid();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureRsvpDeps({ prepaid: () => prepaid });
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-01" });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "t1",
      name: "Thu",
      format: "open",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 4,
      passPrice: 1200,
      adhocFee: 120,
      shareSlug: "series-slug-1",
      passCap: 4,
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpDeps({});
    await t.close();
  });

  describe("tiered, before close", () => {
    it("a non-prepaid member is Requested at tier 2; a prepaid one is Confirmed at tier 1", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      prepaid.markPrepaid(b.id, e.id);

      const ra = await put(e.id, a.clerkUserId);
      expect(ra.status).toBe(200);
      expect((await json(ra)).rsvp).toMatchObject({ status: "requested", tier: 2 });

      const rb = await put(e.id, b.clerkUserId);
      expect((await json(rb)).rsvp).toMatchObject({ status: "confirmed", tier: 1 });

      const got = await send("GET", e.id, a.clerkUserId);
      expect((await json(got)).rsvp).toMatchObject({ status: "requested" });
    });

    it("an admin one-off never gives tier 1, even to a pass holder", async () => {
      const e = await addEvent({ kind: "admin_oneoff", seriesId: null });
      const a = await makeMember(t.db);
      prepaid.markPrepaid(a.id, e.id);
      const res = await put(e.id, a.clerkUserId);
      expect((await json(res)).rsvp).toMatchObject({ status: "requested", tier: 2 });
    });

    it("GET returns null when the member has not RSVPed", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const res = await send("GET", e.id, a.clerkUserId);
      expect(res.status).toBe(200);
      expect((await json(res)).rsvp).toBeNull();
    });
  });

  describe("one RSVP per member", () => {
    it("a second PUT updates the same RSVP instead of adding one", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const first = (await json(await put(e.id, a.clerkUserId))).rsvp!;
      clock.advance(60_000);
      const second = (await json(await put(e.id, a.clerkUserId, { guests: ["Kim"] }))).rsvp!;
      expect(second.id).toBe(first.id);
      const rows = await t.db.select().from(rsvp).where(eq(rsvp.memberId, a.id));
      expect(rows).toHaveLength(1);
    });

    it("concurrent PUTs with different keys still leave exactly one RSVP", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => put(e.id, a.clerkUserId, {}, `race-${String(i)}`)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const rows = await t.db.select().from(rsvp).where(eq(rsvp.memberId, a.id));
      expect(rows).toHaveLength(1);
    });

    it("re-RSVPing after a cancel reuses the row and takes a new place in the queue", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const first = (await json(await put(e.id, a.clerkUserId))).rsvp!;
      await del(e.id, a.clerkUserId);
      clock.advance(5 * 60_000);
      const again = (await json(await put(e.id, a.clerkUserId))).rsvp!;
      expect(again.id).toBe(first.id);
      expect(again.status).toBe("requested");
      const [row] = await t.db.select().from(rsvp).where(eq(rsvp.id, first.id));
      expect(row!.requestedAt.toISOString()).toBe(clock.now().toISOString());
      expect(row!.cancelledAt).toBeNull();
    });
  });

  describe("guests", () => {
    it("the guest limit holds", async () => {
      const e = await addEvent({ maxGuestsPerMember: 1 });
      const a = await makeMember(t.db);
      const res = await put(e.id, a.clerkUserId, { guests: ["Kim", "Lo"] });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "guest_limit", max: 1 });
      expect(await t.db.select().from(rsvp)).toHaveLength(0);
    });

    it("no guests when the limit is 0", async () => {
      const e = await addEvent({ maxGuestsPerMember: 0 });
      const a = await makeMember(t.db);
      expect((await put(e.id, a.clerkUserId, { guests: ["Kim"] })).status).toBe(400);
    });

    it("guests are tier 3 and Requested in tiered mode; fewer guests cancels the extras", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      const one = (await json(await put(e.id, a.clerkUserId, { guests: ["Kim", " "] }))).rsvp!;
      expect(one.guests.map((g) => [g.name, g.status])).toEqual([
        ["Kim", "requested"],
        ["Guest", "requested"],
      ]);
      const two = (await json(await put(e.id, a.clerkUserId, { guests: ["Kimmy"] }))).rsvp!;
      expect(two.guests).toEqual([{ id: one.guests[0]!.id, name: "Kimmy", status: "requested" }]);
      const rows = await t.db.select().from(guest);
      expect(rows.find((g) => g.id === one.guests[1]!.id)!.status).toBe("cancelled");
      expect(rows.every((g) => g.tier === 3)).toBe(true);
    });

    it("rejects malformed bodies", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      for (const body of [{ guests: "Kim" }, { guests: [1] }, { extra: true }, []]) {
        expect((await put(e.id, a.clerkUserId, body)).status).toBe(400);
      }
      expect((await put(e.id, a.clerkUserId, { guests: ["x".repeat(61)] })).status).toBe(400);
    });
  });

  describe("cancel before close", () => {
    it("cancels the RSVP and its guests and creates no ledger entries", async () => {
      const e = await addEvent({ adhocFee: 150 });
      const a = await makeMember(t.db);
      await put(e.id, a.clerkUserId, { guests: ["Kim"] });
      const res = await del(e.id, a.clerkUserId);
      expect(res.status).toBe(200);
      expect((await json(res)).rsvp).toMatchObject({ status: "cancelled", guests: [] });
      const [row] = await t.db.select().from(rsvp);
      expect(row!.status).toBe("cancelled");
      expect(row!.cancelledAt!.toISOString()).toBe(new Date(NOW).toISOString());
      expect((await t.db.select().from(guest)).map((g) => g.status)).toEqual(["cancelled"]);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);
    });

    it("DELETE without an RSVP is 404", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      expect((await del(e.id, a.clerkUserId)).status).toBe(404);
    });
  });

  describe("instant mode", () => {
    it("confirms first-come and waitlists once full, counting guests", async () => {
      const e = await instantEvent(3);
      const [a, b, c] = [await makeMember(t.db), await makeMember(t.db), await makeMember(t.db)];
      const ra = (await json(await put(e.id, a.clerkUserId, { guests: ["Kim"] }))).rsvp!;
      expect(ra.status).toBe("confirmed");
      expect(ra.guests[0]!.status).toBe("confirmed");
      clock.advance(1000);
      expect((await json(await put(e.id, b.clerkUserId))).rsvp!.status).toBe("confirmed");
      clock.advance(1000);
      const rc = (await json(await put(e.id, c.clerkUserId, { guests: ["Lo"] }))).rsvp!;
      expect(rc.status).toBe("waitlisted");
      expect(rc.guests[0]!.status).toBe("waitlisted");
    });

    it("a freed seat goes to the earliest waitlisted, not to a newcomer", async () => {
      const e = await instantEvent(1, 0);
      const [a, b, c] = [await makeMember(t.db), await makeMember(t.db), await makeMember(t.db)];
      await put(e.id, a.clerkUserId);
      clock.advance(1000);
      await put(e.id, b.clerkUserId);
      clock.advance(1000);
      await del(e.id, a.clerkUserId);
      clock.advance(1000);
      expect((await json(await put(e.id, c.clerkUserId))).rsvp!.status).toBe("waitlisted");
      const rb = (await json(await send("GET", e.id, b.clerkUserId))).rsvp!;
      expect(rb.status).toBe("confirmed");
      const promoted = await t.db
        .select()
        .from(domainEventOutbox)
        .where(eq(domainEventOutbox.type, "rsvp_changed"));
      expect(
        promoted.some(
          (row) =>
            (row.payload as { memberId: string }).memberId === b.id &&
            (row.payload as { reason: string }).reason === "promoted",
        ),
      ).toBe(true);
    });

    it("never goes over capacity under concurrent RSVPs", async () => {
      const e = await instantEvent(2, 0);
      const members = await Promise.all(Array.from({ length: 6 }, () => makeMember(t.db)));
      await Promise.all(members.map((m) => put(e.id, m.clerkUserId)));
      const rows = await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id));
      expect(rows.filter((r) => r.status === "confirmed")).toHaveLength(2);
      expect(rows.filter((r) => r.status === "waitlisted")).toHaveLength(4);
    });
  });

  describe("who may RSVP", () => {
    it("pending and inactive members are blocked", async () => {
      const e = await addEvent();
      for (const status of ["pending", "inactive"] as const) {
        const m = await makeMember(t.db, { status });
        expect((await put(e.id, m.clerkUserId)).status).toBe(403);
        expect((await del(e.id, m.clerkUserId)).status).toBe(403);
        expect((await send("GET", e.id, m.clerkUserId)).status).toBe(403);
      }
      expect(await t.db.select().from(rsvp)).toHaveLength(0);
    });

    it("signed-out requests are 401", async () => {
      const e = await addEvent();
      const res = await app().request(`/events/${e.id}/rsvp`, { method: "GET" }, testEnv);
      expect(res.status).toBe(401);
    });

    it("unknown event is 404", async () => {
      const a = await makeMember(t.db);
      expect((await put("evt_missing", a.clerkUserId)).status).toBe(404);
    });

    it("after close, or on a cancelled event, PUT and DELETE are 409 rsvp_closed", async () => {
      const a = await makeMember(t.db);
      const open = await addEvent();
      await put(open.id, a.clerkUserId);
      clock.set(at(24));
      const late = await put(open.id, a.clerkUserId);
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ error: "rsvp_closed" });
      expect((await del(open.id, a.clerkUserId)).status).toBe(409);

      clock.set(NOW);
      const cancelled = await addEvent({ status: "cancelled" });
      expect((await put(cancelled.id, a.clerkUserId)).status).toBe(409);
    });
  });

  describe("idempotency", () => {
    it("a double-submitted PUT has a single effect", async () => {
      const e = await instantEvent(5);
      const a = await makeMember(t.db);
      const [r1, r2] = await Promise.all([
        put(e.id, a.clerkUserId, { guests: ["Kim"] }, "same"),
        put(e.id, a.clerkUserId, { guests: ["Kim"] }, "same"),
      ]);
      // One runs; the twin replays it (200) or sees it still in progress (409). Never two effects.
      const statuses = [r1.status, r2.status].sort();
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);
      const replay = await put(e.id, a.clerkUserId, { guests: ["Kim"] }, "same");
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await t.db.select().from(rsvp)).toHaveLength(1);
      expect(await t.db.select().from(guest)).toHaveLength(1);
      const events = await t.db
        .select()
        .from(domainEventOutbox)
        .where(eq(domainEventOutbox.type, "rsvp_changed"));
      expect(events).toHaveLength(1);
    });

    it("PUT and DELETE require an Idempotency-Key", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      expect((await send("PUT", e.id, a.clerkUserId, { body: {}, key: null })).status).toBe(400);
      expect((await send("DELETE", e.id, a.clerkUserId, { key: null })).status).toBe(400);
    });
  });

  describe("rsvp_changed", () => {
    it("is written to the outbox on PUT and DELETE", async () => {
      const e = await addEvent();
      const a = await makeMember(t.db);
      await put(e.id, a.clerkUserId, { guests: ["Kim"] });
      clock.advance(1000);
      await del(e.id, a.clerkUserId);
      const rows = await t.db
        .select()
        .from(domainEventOutbox)
        .where(eq(domainEventOutbox.type, "rsvp_changed"))
        .orderBy(asc(domainEventOutbox.createdAt));
      expect(rows.map((r) => r.payload)).toEqual([
        expect.objectContaining({
          eventId: e.id,
          memberId: a.id,
          status: "requested",
          previousStatus: null,
          guests: 1,
          reason: "rsvp",
        }),
        expect.objectContaining({
          eventId: e.id,
          memberId: a.id,
          status: "cancelled",
          previousStatus: "requested",
          guests: 0,
          reason: "cancel",
        }),
      ]);
    });
  });

  describe("cancelMemberRsvps (S2.1 deactivation)", () => {
    it("cancels open pre-close RSVPs and guests, leaves closed events alone, and is idempotent", async () => {
      const a = await makeMember(t.db);
      const open = await addEvent();
      const closing = await addEvent({ rsvpCloseAt: at(1), startsAt: at(3), endsAt: at(4) });
      await put(open.id, a.clerkUserId, { guests: ["Kim"] });
      await put(closing.id, a.clerkUserId);
      clock.set(at(2));

      const input = { memberId: a.id, at: clock.now(), idempotencyKey: "member-deactivate:x" };
      await cancelMemberRsvps(t.db, clock, input);
      await cancelMemberRsvps(t.db, clock, input);

      const [openRow] = await t.db
        .select()
        .from(rsvp)
        .where(and(eq(rsvp.eventId, open.id), eq(rsvp.memberId, a.id)));
      expect(openRow!.status).toBe("cancelled");
      expect((await t.db.select().from(guest)).map((g) => g.status)).toEqual(["cancelled"]);
      const [closedRow] = await t.db.select().from(rsvp).where(eq(rsvp.eventId, closing.id));
      expect(closedRow!.status).toBe("requested");
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);
      const cancels = (
        await t.db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.type, "rsvp_changed"))
      ).filter((r) => (r.payload as { reason: string }).reason === "member_exit");
      expect(cancels).toHaveLength(1);
    });
  });
});
