import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { auditLog, event, series, seriesCaptain, term } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { requestIdMiddleware } from "../ops/logging";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { configureEventsDeps } from "./deps";
import { createEvent } from "./model";
import eventsRoutes from "./routes";
import { SLUG_LENGTH } from "./slugs";

const NOW = "2027-03-10T12:00:00Z";
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const HOUR = 3_600_000;
const at = (hoursFromNow: number): Date => new Date(new Date(NOW).getTime() + hoursFromNow * HOUR);

describe("events routes (S3.0)", () => {
  let t: TestDatabase;
  let og: FakePublishOg;
  let seq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => new Date(NOW).getTime() }))
      .route("/", eventsRoutes);

  const as = (clerkUserId: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), [TEST_IDENTITY_HEADER]: clerkUserId },
  });

  const get = (path: string, clerkUserId: string) => app().request(path, as(clerkUserId), testEnv);
  const patch = (path: string, clerkUserId: string, body: unknown) =>
    app().request(
      path,
      as(clerkUserId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      testEnv,
    );

  async function seed() {
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-01" });
    for (const id of ["ser_1", "ser_2"]) {
      await t.db.insert(series).values({
        id,
        termId: "t1",
        name: id,
        format: "open",
        weekday: 4,
        startTime: "19:00",
        durationMin: 90,
        capacity: 12,
        passPrice: 1200,
        adhocFee: 120,
        shareSlug: `series-slug-${id}`,
        passCap: 10,
      });
    }
  }

  async function addEvent(
    createdBy: string,
    over: Partial<typeof event.$inferInsert> & { startsInHours?: number } = {},
  ) {
    const { startsInHours = 24, ...rest } = over;
    seq += 1;
    return createEvent(
      { db: t.db, clock: new FixedClock(NOW), publishOg: og },
      {
        seriesId: "ser_1",
        kind: "series",
        createdBy,
        title: `Session ${String(seq)}`,
        format: "open",
        startsAt: at(startsInHours),
        endsAt: at(startsInHours + 1.5),
        location: "Hall X",
        capacity: 12,
        adhocFee: 0,
        maxGuestsPerMember: 1,
        rsvpCloseAt: at(startsInHours - 1),
        allocationMode: "tiered",
        ...rest,
      },
    );
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    og = new FakePublishOg();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
    configureEventsDeps({ publishOg: () => og });
    await seed();
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureEventsDeps({});
    await t.close();
  });

  it("createEvent gives a random slug of 8+ characters and publishes OG", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const row = await addEvent(admin.id);
    expect(row.shareSlug).toHaveLength(SLUG_LENGTH);
    expect(row.shareSlug.length).toBeGreaterThanOrEqual(8);
    expect(og.calls).toHaveLength(1);
    expect(og.calls[0]!.key).toBe(`og:event:${row.shareSlug}`);
    expect(JSON.parse(og.calls[0]!.html)).toMatchObject({ slug: row.shareSlug, title: row.title });
  });

  it("two events never share a slug", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const slugs = await Promise.all(Array.from({ length: 20 }, () => addEvent(admin.id)));
    expect(new Set(slugs.map((e) => e.shareSlug)).size).toBe(20);
  });

  it("a failing OG publish never fails the write", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    og.publishOg = () => Promise.reject(new Error("kv down"));
    const row = await addEvent(admin.id);
    expect(row.id).toBeTruthy();
  });

  describe("reads", () => {
    it("lists upcoming events soonest first, and past events newest first", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const viewer = await makeMember(t.db);
      const later = await addEvent(admin.id, { startsInHours: 72 });
      const soon = await addEvent(admin.id, { startsInHours: 24 });
      const past = await addEvent(admin.id, { startsInHours: -48, rsvpCloseAt: at(-72) });

      const upcoming = await (await get("/events", viewer.clerkUserId)).json<{
        events: Array<{ id: string }>;
      }>();
      expect(upcoming.events.map((e) => e.id)).toEqual([soon.id, later.id]);

      const history = await (await get("/events?scope=past", viewer.clerkUserId)).json<{
        events: Array<{ id: string }>;
      }>();
      expect(history.events.map((e) => e.id)).toEqual([past.id]);
    });

    it("looks an event up by slug and by id, with viewer flags", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const viewer = await makeMember(t.db);
      const row = await addEvent(admin.id);

      const bySlug = await get(`/events/by-slug/${row.shareSlug}`, viewer.clerkUserId);
      expect(bySlug.status).toBe(200);
      const body = await bySlug.json<{
        event: { id: string; slug: string; readOnly: boolean };
        viewer: { canManage: boolean; canSeeAttendees: boolean };
      }>();
      expect(body.event).toMatchObject({ id: row.id, slug: row.shareSlug, readOnly: false });
      expect(body.viewer).toEqual({ canManage: false, canSeeAttendees: true });

      const byId = await get(`/events/${row.id}`, admin.clerkUserId);
      expect((await byId.json<{ viewer: { canManage: boolean } }>()).viewer.canManage).toBe(true);
    });

    it("answers 404 for an unknown slug", async () => {
      const viewer = await makeMember(t.db);
      expect((await get("/events/by-slug/nope", viewer.clerkUserId)).status).toBe(404);
    });

    it("series next skips cancelled and closed events and returns the earliest open one", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const viewer = await makeMember(t.db);
      await addEvent(admin.id, { startsInHours: 24, status: "cancelled" });
      await addEvent(admin.id, { startsInHours: 30, status: "closed" });
      await addEvent(admin.id, { startsInHours: 36, rsvpCloseAt: at(-1) }); // closed by time
      await addEvent(admin.id, { startsInHours: 40, seriesId: "ser_2" }); // other series
      const open = await addEvent(admin.id, { startsInHours: 168 });
      await addEvent(admin.id, { startsInHours: 240 });

      const res = await get("/series/by-slug/series-slug-ser_1/next", viewer.clerkUserId);
      expect(res.status).toBe(200);
      expect((await res.json<{ event: { id: string } }>()).event.id).toBe(open.id);
    });

    it("series next is 404 when nothing is open, or the slug is unknown", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await addEvent(admin.id, { status: "cancelled" });
      expect((await get("/series/by-slug/series-slug-ser_1/next", admin.clerkUserId)).status).toBe(404);
      expect((await get("/series/by-slug/missing/next", admin.clerkUserId)).status).toBe(404);
    });
  });

  describe("access", () => {
    it("401 without identity", async () => {
      expect((await app().request("/events", {}, testEnv)).status).toBe(401);
    });

    it("a pending member is refused and gets no event or attendee data", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const pending = await makeMember(t.db, { status: "pending" });
      const row = await addEvent(admin.id);
      const res = await get(`/events/by-slug/${row.shareSlug}`, pending.clerkUserId);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("attendees");
      expect(text).not.toContain(row.title);
    });
  });

  describe("writes", () => {
    it("the creator edits their one-off; audit row and OG publish follow", async () => {
      const owner = await makeMember(t.db);
      const row = await addEvent(owner.id, { kind: "member_oneoff", seriesId: null });
      og.calls.length = 0;

      const res = await patch(`/events/${row.id}`, owner.clerkUserId, {
        title: "Friday fun",
        location: "Hall Y",
      });
      expect(res.status).toBe(200);
      const [saved] = await t.db.select().from(event).where(eq(event.id, row.id));
      expect(saved).toMatchObject({ title: "Friday fun", location: "Hall Y" });
      expect(og.calls).toHaveLength(1);
      expect(JSON.parse(og.calls[0]!.html)).toMatchObject({ title: "Friday fun" });
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, row.id));
      expect(audits.map((a) => a.action)).toContain("event.update");
    });

    it("an admin and the series captain may edit a series event; another member may not", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const captain = await makeMember(t.db);
      const other = await makeMember(t.db);
      await t.db.insert(seriesCaptain).values({ seriesId: "ser_1", memberId: captain.id });
      const row = await addEvent(admin.id);

      expect((await patch(`/events/${row.id}`, other.clerkUserId, { title: "x" })).status).toBe(403);
      expect((await patch(`/events/${row.id}`, captain.clerkUserId, { title: "By captain" })).status).toBe(200);
      expect((await patch(`/events/${row.id}`, admin.clerkUserId, { title: "By admin" })).status).toBe(200);
    });

    it("past events are read-only: 409, nothing saved, nothing published", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const row = await addEvent(admin.id, { startsInHours: -48, rsvpCloseAt: at(-72) });
      og.calls.length = 0;

      const res = await patch(`/events/${row.id}`, admin.clerkUserId, { title: "Rewrite history" });
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBe("event_read_only");
      const [saved] = await t.db.select().from(event).where(eq(event.id, row.id));
      expect(saved!.title).toBe(row.title);
      expect(og.calls).toHaveLength(0);

      const detail = await get(`/events/${row.id}`, admin.clerkUserId);
      expect((await detail.json<{ event: { readOnly: boolean } }>()).event.readOnly).toBe(true);
    });

    it("rejects an empty title and unknown fields", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const row = await addEvent(admin.id);
      expect((await patch(`/events/${row.id}`, admin.clerkUserId, { title: "  " })).status).toBe(400);
      expect((await patch(`/events/${row.id}`, admin.clerkUserId, { capacity: 1 })).status).toBe(400);
    });

    it("404 for an unknown event", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      expect((await patch("/events/nope", admin.clerkUserId, { title: "x" })).status).toBe(404);
    });
  });
});
