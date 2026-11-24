/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- response bodies are asserted field by field. */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, event, pass, series, seriesCaptain, term } from "../../../db/schema";
import { localParts } from "../../domain/recurrence";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
type Member = Awaited<ReturnType<typeof makeMember>>;

describe("recurrence, skip-dates, occurrence edits (S3.2)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let admin: Member;
  let captain: Member;
  let plain: Member;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-02-01T09:00:00Z");
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    admin = await makeMember(t.db, { role: "admin" });
    captain = await makeMember(t.db);
    plain = await makeMember(t.db);
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  async function call(as: Member | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await routes.request(path, init, testEnv);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Sunday series over March-April 2027: crosses the spring DST shift on 2027-03-28. */
  async function seed(status: "draft" | "open_for_passes" | "active" | "closed" = "draft") {
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-03-01", endsOn: "2027-04-30", status });
    await t.db.insert(series).values({
      id: "s1",
      termId: "t1",
      name: "Sunday XD",
      format: "XD",
      weekday: 7,
      startTime: "19:00",
      durationMin: 90,
      location: "Hall A",
      capacity: 16,
      passPrice: 1800,
      adhocFee: 120,
      maxGuestsDefault: 1,
      rsvpCloseOffsetMin: 1440,
      shareSlug: "slug-s1-abcdefgh",
      skipDatesLocked: status !== "draft",
      passCap: 16,
    });
    await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
  }

  const eventsOf = () =>
    t.db.select().from(event).where(eq(event.seriesId, "s1")).orderBy(asc(event.startsAt));

  async function seedPasses(n: number) {
    for (let i = 0; i < n; i++) {
      const buyer = await makeMember(t.db);
      await t.db.insert(pass).values({
        id: `p${String(i)}`,
        memberId: buyer.id,
        seriesId: "s1",
        priceCharged: 1800,
        eventsCovered: 9,
      });
    }
  }

  describe("generation", () => {
    it("creates one event per Sunday at 19:00 Stockholm time, with rsvpCloseAt 1440 absolute minutes before", async () => {
      await seed();
      const res = await call(admin, "POST", "/series/s1/generate-events");
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(8);
      const rows = await eventsOf();
      expect(rows).toHaveLength(8);
      for (const e of rows) {
        expect(localParts(e.startsAt)).toMatchObject({ weekday: 7, time: "19:00" });
        expect(e.startsAt.getTime() - e.rsvpCloseAt.getTime()).toBe(1440 * 60_000);
        expect(e).toMatchObject({
          kind: "series",
          title: "Sunday XD",
          capacity: 16,
          adhocFee: 120,
          maxGuestsPerMember: 1,
          location: "Hall A",
          allocationMode: "tiered",
          status: "scheduled",
        });
      }
      const shift = rows.find((e) => localParts(e.startsAt).date === "2027-03-28");
      expect(shift?.startsAt.toISOString()).toBe("2027-03-28T17:00:00.000Z");
    });

    it("is idempotent and keeps manual edits", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const [first] = await eventsOf();
      const edit = await call(admin, "PATCH", `/series/s1/occurrences/${first!.id}`, {
        location: "Hall B",
        startTime: "18:30",
      });
      expect(edit.status).toBe(200);

      const again = await call(admin, "POST", "/series/s1/generate-events");
      expect(again.status).toBe(200);
      expect(again.body.created).toBe(0);
      const rows = await eventsOf();
      expect(rows).toHaveLength(8);
      const kept = rows.find((e) => e.id === first!.id);
      expect(kept?.location).toBe("Hall B");
      expect(localParts(kept!.startsAt).time).toBe("18:30");
    });

    it("never recreates a cancelled occurrence and skips occurrences whose RSVP window has passed", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const [first] = await eventsOf();
      await t.db.update(event).set({ status: "cancelled" }).where(eq(event.id, first!.id));
      await t.db.delete(event).where(eq(event.id, (await eventsOf())[1]!.id));
      // 2027-03-14 19:00 closes 2027-03-13 18:00Z; move past it so 03-14 is no longer generated.
      clock.set("2027-03-13T19:00:00Z");
      const res = await call(admin, "POST", "/series/s1/generate-events");
      expect(res.body.created).toBe(0);
      expect(await eventsOf()).toHaveLength(7);
    });

    it("adds new occurrences when a skip-date is removed", async () => {
      await seed();
      await call(admin, "PUT", "/series/s1/skip-dates", { skipDates: ["2027-04-04"] });
      expect((await call(admin, "POST", "/series/s1/generate-events")).body.created).toBe(7);
      await call(admin, "PUT", "/series/s1/skip-dates", { skipDates: [] });
      expect((await call(admin, "POST", "/series/s1/generate-events")).body.created).toBe(1);
    });

    it("is admin only and refused for a closed term", async () => {
      await seed();
      expect((await call(captain, "POST", "/series/s1/generate-events")).status).toBe(403);
      await t.db.update(term).set({ status: "closed" });
      const res = await call(admin, "POST", "/series/s1/generate-events");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("term_closed");
    });

    it("writes one audit row per generation run", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "series.generate"));
      expect(rows).toHaveLength(1);
    });
  });

  describe("occurrences list", () => {
    it("shows planned, skipped and generated occurrences to the captain, not a plain member", async () => {
      await seed();
      await call(admin, "PUT", "/series/s1/skip-dates", { skipDates: ["2027-04-04"] });
      await call(admin, "POST", "/series/s1/generate-events");
      expect((await call(plain, "GET", "/series/s1/occurrences")).status).toBe(403);
      const res = await call(captain, "GET", "/series/s1/occurrences");
      expect(res.status).toBe(200);
      expect(res.body.occurrences).toHaveLength(8);
      const skipped = res.body.occurrences.find((o: { date: string }) => o.date === "2027-04-04");
      expect(skipped).toMatchObject({ skipped: true, event: null });
      const generated = res.body.occurrences.find((o: { date: string }) => o.date === "2027-03-07");
      expect(generated.event).toMatchObject({ capacity: 16, status: "scheduled" });
    });
  });

  describe("skip-date lock", () => {
    it("edits skip-dates while the term is a draft", async () => {
      await seed();
      const res = await call(admin, "PUT", "/series/s1/skip-dates", {
        skipDates: ["2027-04-04", "2027-03-28"],
      });
      expect(res.status).toBe(200);
      expect(res.body.skipDates).toEqual(["2027-03-28", "2027-04-04"]);
    });

    it("holds once sales open, unless an admin overrides (audited)", async () => {
      await seed("open_for_passes");
      const blocked = await call(admin, "PUT", "/series/s1/skip-dates", {
        skipDates: ["2027-04-04"],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe("skip_dates_locked");
      const [row] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(row?.skipDates).toEqual([]);

      const forced = await call(admin, "PUT", "/series/s1/skip-dates", {
        skipDates: ["2027-04-04"],
        overrideLock: true,
      });
      expect(forced.status).toBe(200);
      const [after] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(after?.skipDatesLocked).toBe(true);
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "series.skip_dates"));
      expect(audits.some((a) => (a.after ?? "").includes("overrideLock"))).toBe(true);
    });

    it("rejects dates outside the term or on the wrong weekday, and captains", async () => {
      await seed();
      const wrongDay = await call(admin, "PUT", "/series/s1/skip-dates", {
        skipDates: ["2027-04-05"],
      });
      expect(wrongDay.status).toBe(422);
      const outside = await call(admin, "PUT", "/series/s1/skip-dates", {
        skipDates: ["2027-05-02"],
      });
      expect(outside.status).toBe(422);
      const byCaptain = await call(captain, "PUT", "/series/s1/skip-dates", { skipDates: [] });
      expect(byCaptain.status).toBe(403);
    });

    it("refuses to skip a date that already has a live event", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const res = await call(admin, "PUT", "/series/s1/skip-dates", { skipDates: ["2027-03-07"] });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("skip_date_has_event");
    });
  });

  describe("occurrence edits", () => {
    it("blocks a capacity that puts the cap below passes sold unless an admin overrides", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      await seedPasses(5);
      const [first] = await eventsOf();

      const blocked = await call(admin, "PATCH", `/series/s1/occurrences/${first!.id}`, {
        capacity: 4,
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({
        error: "cap_below_passes_sold",
        passCap: 4,
        passesSold: 5,
      });
      expect((await eventsOf())[0]?.capacity).toBe(16);

      const forced = await call(admin, "PATCH", `/series/s1/occurrences/${first!.id}`, {
        capacity: 4,
        overrideCapBelowSold: true,
      });
      expect(forced.status).toBe(200);
      const [s] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(s?.passCap).toBe(4);
    });

    it("allows lowering capacity while the cap stays at or above passes sold", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      await seedPasses(5);
      const [first] = await eventsOf();
      const res = await call(admin, "PATCH", `/series/s1/occurrences/${first!.id}`, {
        capacity: 5,
      });
      expect(res.status).toBe(200);
      expect(res.body.event.capacity).toBe(5);
    });

    it("recomputes rsvpCloseAt from the new start time in absolute minutes", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const shift = (await eventsOf()).find((e) => localParts(e.startsAt).date === "2027-03-28");
      const res = await call(admin, "PATCH", `/series/s1/occurrences/${shift!.id}`, {
        startTime: "20:00",
        rsvpCloseOffsetMin: 120,
      });
      expect(res.status).toBe(200);
      expect(res.body.event.startsAt).toBe("2027-03-28T18:00:00.000Z");
      expect(res.body.event.rsvpCloseAt).toBe("2027-03-28T16:00:00.000Z");
      expect(res.body.event.endsAt).toBe("2027-03-28T19:30:00.000Z");
    });

    it("lets a captain change location and guests, but not capacity or time", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const [first] = await eventsOf();
      const path = `/series/s1/occurrences/${first!.id}`;
      expect((await call(captain, "PATCH", path, { location: "Hall C" })).status).toBe(200);
      const denied = await call(captain, "PATCH", path, { capacity: 10 });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe("forbidden_field");
      expect((await call(plain, "PATCH", path, { location: "x" })).status).toBe(403);
    });

    it("refuses edits once RSVPs have closed, and events of another series", async () => {
      await seed();
      await call(admin, "POST", "/series/s1/generate-events");
      const [first] = await eventsOf();
      clock.set(first!.rsvpCloseAt);
      const closed = await call(admin, "PATCH", `/series/s1/occurrences/${first!.id}`, {
        location: "x",
      });
      expect(closed.status).toBe(409);
      expect(closed.body.error).toBe("event_closed");
      const other = await call(admin, "PATCH", `/series/s2/occurrences/${first!.id}`, {
        location: "x",
      });
      expect(other.status).toBe(404);
    });
  });
});
