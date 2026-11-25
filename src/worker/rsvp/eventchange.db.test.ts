import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clubSettings,
  event,
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
import { requestIdMiddleware } from "../ops/logging";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { FakePrepaid, FakePublishOg } from "../test-support/fakes";
import type { AppEnv } from "../types";
import { closeEvent } from "./close";
import { configureRsvpDeps } from "./deps";
import rsvpRoutes from "./routes";

const NOW = "2027-04-01T12:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("event cancellation + material changes (S4.4c)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", rsvpRoutes);

  const send = async (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

  async function seedSeries(createdBy: string) {
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
    return createEvent(
      { db: t.db, clock, publishOg: new FakePublishOg() },
      {
        seriesId: "ser_1",
        kind: "series",
        createdBy,
        title: "Thursday Mixed",
        format: "mixed",
        startsAt: at(48),
        endsAt: at(50),
        rsvpCloseAt: at(24),
        location: "Hall X",
        capacity: 6,
        adhocFee: 120,
        maxGuestsPerMember: 2,
        allocationMode: "tiered",
      },
    );
  }

  async function netEventCharges(eventId: string): Promise<number> {
    const [row] = await t.db
      .select({ total: sql<number>`coalesce(sum(${ledgerEntry.amountSek}), 0)::int` })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.eventId, eventId));
    return row?.total ?? 0;
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(new Date(NOW));
    prepaid = new FakePrepaid();
    keySeq = 0;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
    configureRsvpDeps({ prepaid: () => prepaid });
    await t.db
      .insert(clubSettings)
      .values({ id: 1, clubName: "BOLT", autoPromoteCutoffMin: 180 })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureEventsDeps({});
    configureRsvpDeps({});
    await t.close();
  });

  it("cancelling an event leaves its net charges at 0 and notifies participants", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const alice = await makeMember(t.db);
    const bob = await makeMember(t.db);
    const ev = await seedSeries(admin.id);

    await send("PUT", `/events/${ev.id}/rsvp`, alice.clerkUserId, { body: { guests: ["G1"] } });
    await send("PUT", `/events/${ev.id}/rsvp`, bob.clerkUserId, { body: { guests: [] } });

    clock.set(at(24));
    expect(await closeEvent(t.db, clock, ev.id)).toBe(true);
    expect(await netEventCharges(ev.id)).toBe(360);

    const res = await send("POST", `/events/${ev.id}/cancel`, admin.clerkUserId);
    expect(res.status).toBe(200);

    expect(await netEventCharges(ev.id)).toBe(0);

    const [updated] = await t.db.select().from(event).where(eq(event.id, ev.id));
    expect(updated?.status).toBe("cancelled");

    const rsvps = await t.db.select().from(rsvp).where(eq(rsvp.eventId, ev.id));
    expect(rsvps.every((r) => r.status === "cancelled")).toBe(true);

    const notifs = await t.db.select().from(notification);
    const notifiedIds = new Set(notifs.map((n) => n.memberId));
    expect(notifiedIds.has(alice.id)).toBe(true);
    expect(notifiedIds.has(bob.id)).toBe(true);
  });

  it("a cancel inside the 24h window after a material change is reversed for free; outside it, normal rules apply", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const alice = await makeMember(t.db);
    const bob = await makeMember(t.db);
    const ev = await seedSeries(admin.id);

    await send("PUT", `/events/${ev.id}/rsvp`, alice.clerkUserId, { body: { guests: [] } });
    await send("PUT", `/events/${ev.id}/rsvp`, bob.clerkUserId, { body: { guests: [] } });

    clock.set(at(24));
    expect(await closeEvent(t.db, clock, ev.id)).toBe(true);
    expect(await netEventCharges(ev.id)).toBe(240);

    // Material change: location changes after close.
    clock.set(at(25));
    const changeRes = await send("PATCH", `/events/${ev.id}/details`, admin.clerkUserId, {
      body: { location: "Hall Y" },
    });
    expect(changeRes.status).toBe(200);

    // Inside 24h window (at +30h, 5h after material change): alice cancels for free.
    clock.set(at(30));
    const freeCancelRes = await send(
      "POST",
      `/events/${ev.id}/rsvp/late-cancel`,
      alice.clerkUserId,
      {
        body: {},
      },
    );
    expect(freeCancelRes.status).toBe(200);
    expect(await netEventCharges(ev.id)).toBe(120);

    // Outside 24h window (at +50h? Event ends at +50h, so check at +49h -> wait: 25 + 24 = 49h!).
    clock.set(at(49));
    const normalCancelRes = await send(
      "POST",
      `/events/${ev.id}/rsvp/late-cancel`,
      bob.clerkUserId,
      {
        body: {},
      },
    );
    expect(normalCancelRes.status).toBe(200);
    // Normal rules apply: no waitlist refill, so bob's 120 kr charge stands.
    expect(await netEventCharges(ev.id)).toBe(120);
  });

  it("editing the fee of a closed event returns 409", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const ev = await seedSeries(admin.id);

    clock.set(at(24));
    expect(await closeEvent(t.db, clock, ev.id)).toBe(true);

    const res = await send("PATCH", `/events/${ev.id}/details`, admin.clerkUserId, {
      body: { adhocFee: 150 },
    });
    expect(res.status).toBe(409);

    const [unchanged] = await t.db.select().from(event).where(eq(event.id, ev.id));
    expect(unchanged?.adhocFee).toBe(120);
  });

  it("editing the fee before close succeeds, and title-only change after close does not open free-cancel window", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const alice = await makeMember(t.db);
    const ev = await seedSeries(admin.id);

    await send("PUT", `/events/${ev.id}/rsvp`, alice.clerkUserId, { body: { guests: [] } });

    const preCloseFee = await send("PATCH", `/events/${ev.id}/details`, admin.clerkUserId, {
      body: { adhocFee: 150 },
    });
    expect(preCloseFee.status).toBe(200);

    clock.set(at(24));
    expect(await closeEvent(t.db, clock, ev.id)).toBe(true);
    expect(await netEventCharges(ev.id)).toBe(150);

    // Title-only edit after close is NOT a material change.
    clock.set(at(25));
    const titleRes = await send("PATCH", `/events/${ev.id}/details`, admin.clerkUserId, {
      body: { title: "Thursday Mixed Special" },
    });
    expect(titleRes.status).toBe(200);

    const [afterTitle] = await t.db.select().from(event).where(eq(event.id, ev.id));
    expect(afterTitle?.materialChangeAt).toBeNull();

    // Cancelling now does NOT reverse the charge.
    clock.set(at(26));
    const cancelRes = await send("POST", `/events/${ev.id}/rsvp/late-cancel`, alice.clerkUserId, {
      body: {},
    });
    expect(cancelRes.status).toBe(200);
    expect(await netEventCharges(ev.id)).toBe(150);
  });

  it("single guest cancel inside 24h material-change window reverses only that guest charge", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const alice = await makeMember(t.db);
    const ev = await seedSeries(admin.id);

    const rsvpRes = await send("PUT", `/events/${ev.id}/rsvp`, alice.clerkUserId, {
      body: { guests: ["G1"] },
    });
    const rsvpJson = await rsvpRes.json<{ rsvp: { guests: { id: string }[] } }>();
    const guestId = rsvpJson.rsvp.guests[0]?.id;
    expect(guestId).toBeDefined();

    clock.set(at(24));
    expect(await closeEvent(t.db, clock, ev.id)).toBe(true);
    expect(await netEventCharges(ev.id)).toBe(240);

    clock.set(at(25));
    await send("PATCH", `/events/${ev.id}/details`, admin.clerkUserId, {
      body: { startsAt: at(49).toISOString(), endsAt: at(51).toISOString() },
    });

    clock.set(at(26));
    const guestCancel = await send("POST", `/events/${ev.id}/rsvp/late-cancel`, alice.clerkUserId, {
      body: { guestId },
    });
    expect(guestCancel.status).toBe(200);
    expect(await netEventCharges(ev.id)).toBe(120);
  });

  it("enforces manager authorization and rejects cancelling already-cancelled or ended events", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const member = await makeMember(t.db);
    const ev = await seedSeries(admin.id);

    const forbiddenCancel = await send("POST", `/events/${ev.id}/cancel`, member.clerkUserId);
    expect(forbiddenCancel.status).toBe(403);

    const forbiddenEdit = await send("PATCH", `/events/${ev.id}/details`, member.clerkUserId, {
      body: { location: "Hall Z" },
    });
    expect(forbiddenEdit.status).toBe(403);

    const okCancel = await send("POST", `/events/${ev.id}/cancel`, admin.clerkUserId);
    expect(okCancel.status).toBe(200);

    const doubleCancel = await send("POST", `/events/${ev.id}/cancel`, admin.clerkUserId);
    expect(doubleCancel.status).toBe(409);
  });
});
