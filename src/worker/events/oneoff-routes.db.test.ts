import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import {
  auditLog,
  event,
  notification,
  pass,
  series,
  seriesCaptain,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { requestIdMiddleware } from "../ops/logging";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { configureEventsDeps } from "./deps";
import eventsRoutes from "./routes";

const NOW = "2027-03-10T12:00:00Z";
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const HOUR = 3_600_000;
const at = (h: number) => new Date(new Date(NOW).getTime() + h * HOUR).toISOString();

describe("one-off events (S3.3)", () => {
  let t: TestDatabase;
  let og: FakePublishOg;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => new Date(NOW).getTime() }))
      .route("/", eventsRoutes);

  const send = (method: string, path: string, clerkUserId: string, body: unknown, key?: string) =>
    app().request(
      path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          [TEST_IDENTITY_HEADER]: clerkUserId,
          ...(method === "POST" ? { "Idempotency-Key": key ?? `k${String(++keySeq)}` } : {}),
        },
        body: JSON.stringify(body),
      },
      testEnv,
    );

  const input = (over: Record<string, unknown> = {}) => ({
    title: "Friday hit",
    startsAt: at(48),
    endsAt: at(50),
    capacity: 8,
    ...over,
  });

  const create = async (clerkUserId: string, over: Record<string, unknown> = {}) => {
    const res = await send("POST", "/events", clerkUserId, input(over));
    return {
      res,
      body: await res.json<{ event?: { id: string; slug: string }; error?: string }>(),
    };
  };

  const row = async (id: string) => (await t.db.select().from(event).where(eq(event.id, id)))[0]!;

  beforeEach(async () => {
    t = await createTestDatabase();
    og = new FakePublishOg();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
    configureEventsDeps({ publishOg: () => og });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureEventsDeps({});
    await t.close();
  });

  it("a member creates a free, instant member one-off through createEvent", async () => {
    const m = await makeMember(t.db);
    const { res, body } = await create(m.clerkUserId, { location: "Hall X" });
    expect(res.status).toBe(201);
    const saved = await row(body.event!.id);
    expect(saved).toMatchObject({
      kind: "member_oneoff",
      seriesId: null,
      createdBy: m.id,
      adhocFee: 0,
      allocationMode: "instant",
      maxGuestsPerMember: 1,
      location: "Hall X",
      shareSlug: body.event!.slug,
    });
    expect(saved.rsvpCloseAt.toISOString()).toBe(at(24));
    expect(og.calls).toHaveLength(1);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, saved.id));
    expect(audits.map((a) => a.action)).toEqual(["event.create"]);
  });

  it("a member can set an outside-app cost, but can't create club-billed or tiered events", async () => {
    const m = await makeMember(t.db);
    const ok = await create(m.clerkUserId, { adhocFee: 100 });
    expect(ok.res.status).toBe(201);
    expect(await row(ok.body.event!.id)).toMatchObject({
      kind: "member_oneoff",
      adhocFee: 100,
      allocationMode: "instant",
    });
    for (const over of [{ allocationMode: "tiered" }, { eventScope: "club" }]) {
      const { res, body } = await create(m.clerkUserId, over);
      expect(res.status).toBe(403);
      expect(body.error).toBe("admin_only");
    }
    expect(await t.db.select().from(event)).toHaveLength(1);
  });

  it("an admin creates a paid, tiered admin one-off", async () => {
    const a = await makeMember(t.db, { role: "admin" });
    const { res, body } = await create(a.clerkUserId, {
      adhocFee: 150,
      allocationMode: "tiered",
      maxGuestsPerMember: 2,
      rsvpCloseAt: at(40),
      format: "Mixed Doubles",
    });
    expect(res.status).toBe(201);
    expect(await row(body.event!.id)).toMatchObject({
      kind: "admin_oneoff",
      adhocFee: 150,
      allocationMode: "tiered",
      maxGuestsPerMember: 2,
      format: "Mixed Doubles",
    });
  });

  it("an admin's free one-off is still an admin one-off", async () => {
    const a = await makeMember(t.db, { role: "admin" });
    const { body } = await create(a.clerkUserId);
    expect((await row(body.event!.id)).kind).toBe("admin_oneoff");
  });

  it("rejects bad input with 400, pending members with 403, and needs an Idempotency-Key", async () => {
    const m = await makeMember(t.db);
    expect((await create(m.clerkUserId, { capacity: 0 })).res.status).toBe(400);
    const p = await makeMember(t.db, { status: "pending" });
    expect((await create(p.clerkUserId)).res.status).toBe(403);
    const noKey = await app().request(
      "/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", [TEST_IDENTITY_HEADER]: m.clerkUserId },
        body: JSON.stringify(input()),
      },
      testEnv,
    );
    expect(noKey.status).toBe(400);
  });

  it("a double-submitted create makes one event", async () => {
    const m = await makeMember(t.db);
    const first = await send("POST", "/events", m.clerkUserId, input(), "same");
    const second = await send("POST", "/events", m.clerkUserId, input(), "same");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await t.db.select().from(event)).toHaveLength(1);
  });

  it("only the owner, a captain of its series or an admin can edit", async () => {
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-01" });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "t1",
      name: "Thu",
      format: "Open",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 12,
      passPrice: 1200,
      adhocFee: 120,
      shareSlug: "series-slug-1",
      passCap: 10,
    });
    const owner = await makeMember(t.db);
    const other = await makeMember(t.db);
    const captain = await makeMember(t.db);
    await t.db.insert(seriesCaptain).values({ seriesId: "ser_1", memberId: captain.id });
    const admin = await makeMember(t.db, { role: "admin" });
    const { body } = await create(owner.clerkUserId);
    const path = `/events/${body.event!.id}`;

    expect((await send("PATCH", path, other.clerkUserId, { title: "Mine" })).status).toBe(403);
    // A one-off has no series, so a captain of some series gets no edit right on it.
    expect((await send("PATCH", path, captain.clerkUserId, { title: "Mine" })).status).toBe(403);
    expect((await send("PATCH", path, owner.clerkUserId, { title: "Owner" })).status).toBe(200);
    expect((await send("PATCH", path, admin.clerkUserId, { title: "Admin" })).status).toBe(200);
    expect((await row(body.event!.id)).title).toBe("Admin");
  });

  it("notifies eligible members with new_events and restricts access to invited groups", async () => {
    const organizer = await makeMember(t.db, { displayName: "Org" });
    const invited = await makeMember(t.db, { displayName: "Invited" });
    const outsider = await makeMember(t.db, { displayName: "Outsider" });
    const admin = await makeMember(t.db, { role: "admin", displayName: "Admin" });

    // Picked-members event: only invited gets notified; outsider gets 403 and doesn't see it in /events.
    const { res, body } = await create(organizer.clerkUserId, {
      title: "Private Hit",
      audienceKind: "members",
      eligibleMemberIds: [invited.id],
    });
    expect(res.status).toBe(201);
    const id = body.event!.id;

    const notifs = await t.db.select().from(notification);
    expect(notifs.map((n) => ({ memberId: n.memberId, category: n.category }))).toEqual([
      { memberId: invited.id, category: "new_events" },
    ]);

    const getAs = (clerkUserId: string, path: string) =>
      app().request(path, { headers: { [TEST_IDENTITY_HEADER]: clerkUserId } }, testEnv);

    expect((await getAs(invited.clerkUserId, `/events/${id}`)).status).toBe(200);
    expect((await getAs(organizer.clerkUserId, `/events/${id}`)).status).toBe(200);
    expect((await getAs(admin.clerkUserId, `/events/${id}`)).status).toBe(200);
    const blocked = await getAs(outsider.clerkUserId, `/events/${id}`);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "not_eligible" });

    const outsiderList = await (
      await getAs(outsider.clerkUserId, "/events")
    ).json<{
      events: Array<{ id: string }>;
    }>();
    expect(outsiderList.events).toHaveLength(0);
    const invitedList = await (
      await getAs(invited.clerkUserId, "/events")
    ).json<{
      events: Array<{ id: string }>;
    }>();
    expect(invitedList.events.map((e) => e.id)).toEqual([id]);

    // Series pass holders group: only active pass holders of that series see and get notified.
    await t.db.insert(term).values({
      id: "t_grp",
      name: "Spring",
      startsOn: "2027-01-01",
      endsOn: "2027-06-01",
      status: "active",
    });
    await t.db.insert(series).values({
      id: "ser_grp",
      termId: "t_grp",
      name: "Sunday",
      format: "Open",
      weekday: 7,
      startTime: "18:00",
      durationMin: 120,
      capacity: 12,
      passPrice: 1000,
      adhocFee: 100,
      shareSlug: "sunday-grp",
      passCap: 12,
    });
    await t.db.insert(pass).values({
      id: "pas_grp_1",
      memberId: invited.id,
      seriesId: "ser_grp",
      priceCharged: 1000,
      eventsCovered: 10,
      status: "active",
    });

    const seriesEvt = await create(admin.clerkUserId, {
      title: "Sunday Extra",
      audienceKind: "series",
      audienceSeriesId: "ser_grp",
    });
    expect(seriesEvt.res.status).toBe(201);
    expect((await getAs(invited.clerkUserId, `/events/${seriesEvt.body.event!.id}`)).status).toBe(
      200,
    );
    expect((await getAs(outsider.clerkUserId, `/events/${seriesEvt.body.event!.id}`)).status).toBe(
      403,
    );
  });
});
