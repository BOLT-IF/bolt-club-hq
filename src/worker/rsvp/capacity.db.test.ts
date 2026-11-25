import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clubSettings,
  event,
  ledgerEntry,
  notification,
  rsvp,
  series,
  seriesCaptain,
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
import capacityRoutes from "./capacity";
import { closeEvent } from "./close";
import { configureRsvpDeps } from "./deps";
import rsvpRoutes from "./routes";

const NOW = "2027-04-01T12:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("event capacity changes (S4.4b)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", rsvpRoutes)
      .route("/", capacityRoutes);

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
    return {
      admin,
      event: await createEvent(
        { db: t.db, clock, publishOg: new FakePublishOg() },
        {
          seriesId: "ser_1",
          kind: "series",
          createdBy: admin.id,
          title: "Thursday Mixed",
          format: "mixed",
          startsAt: at(48),
          endsAt: at(50),
          location: "Hall X",
          capacity: 4,
          adhocFee: 120,
          maxGuestsPerMember: 2,
          rsvpCloseAt: at(24),
          allocationMode: "tiered",
          ...over,
        },
      ),
    };
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(new Date(NOW));
    prepaid = new FakePrepaid();
    keySeq = 0;
    await t.db
      .insert(clubSettings)
      .values({ id: 1, clubName: "BOLT", autoPromoteCutoffMin: 180 })
      .onConflictDoNothing();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureRsvpDeps({ prepaid: () => prepaid });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpDeps({});
    configureEventsDeps({});
    await t.close();
  });

  it("lowering capacity below confirmed tier-1 is blocked without an override", async () => {
    const { admin, event: e } = await addEvent({ capacity: 4 });
    const p1 = await makeMember(t.db);
    const p2 = await makeMember(t.db);
    const p3 = await makeMember(t.db);
    prepaid.markPrepaid(p1.id, e.id);
    prepaid.markPrepaid(p2.id, e.id);
    prepaid.markPrepaid(p3.id, e.id);

    await send("PUT", `/events/${e.id}/rsvp`, p1.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, p2.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, p3.clerkUserId, { body: { guests: [] } });

    const res = await send("PATCH", `/events/${e.id}/capacity`, admin.clerkUserId, {
      body: { capacity: 2 },
    });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("capacity_below_confirmed");

    const [unchanged] = await t.db.select().from(event).where(eq(event.id, e.id));
    expect(unchanged?.capacity).toBe(4);
  });

  it("the override waitlists the latest prepaid members and notifies them", async () => {
    const { admin, event: e } = await addEvent({ capacity: 4 });
    const p1 = await makeMember(t.db);
    const p2 = await makeMember(t.db);
    const p3 = await makeMember(t.db);
    prepaid.markPrepaid(p1.id, e.id);
    prepaid.markPrepaid(p2.id, e.id);
    prepaid.markPrepaid(p3.id, e.id);

    await send("PUT", `/events/${e.id}/rsvp`, p1.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, p2.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, p3.clerkUserId, { body: { guests: [] } });

    // Non-admin captain cannot override.
    const captain = await makeMember(t.db);
    await t.db.insert(seriesCaptain).values({ seriesId: "ser_1", memberId: captain.id });
    const forbiddenRes = await send("PATCH", `/events/${e.id}/capacity`, captain.clerkUserId, {
      body: { capacity: 1, override: true },
    });
    expect(forbiddenRes.status).toBe(403);

    // Admin overrides down to 1: p2 and p3 (the latest prepaid members) are waitlisted.
    const res = await send("PATCH", `/events/${e.id}/capacity`, admin.clerkUserId, {
      body: { capacity: 1, override: true },
    });
    expect(res.status).toBe(200);

    const rows = await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id));
    const byMember = new Map(rows.map((r) => [r.memberId, r]));
    expect(byMember.get(p1.id)?.status).toBe("confirmed");
    expect(byMember.get(p2.id)?.status).toBe("waitlisted");
    expect(byMember.get(p3.id)?.status).toBe("waitlisted");

    const p2Notes = await t.db.select().from(notification).where(eq(notification.memberId, p2.id));
    const p3Notes = await t.db.select().from(notification).where(eq(notification.memberId, p3.id));
    expect(p2Notes.length).toBeGreaterThanOrEqual(1);
    expect(p3Notes.length).toBeGreaterThanOrEqual(1);
  });

  it("raising capacity promotes from the waitlist", async () => {
    const { admin, event: e } = await addEvent({ capacity: 1 });
    const m1 = await makeMember(t.db);
    const m2 = await makeMember(t.db);

    await send("PUT", `/events/${e.id}/rsvp`, m1.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, m2.clerkUserId, { body: { guests: [] } });

    // Close: m1 confirmed, m2 waitlisted.
    clock.set(at(25));
    await closeEvent(t.db, clock, e.id);

    // Raise capacity from 1 to 2 before cutoff -> m2 is promoted, charged, and notified.
    clock.set(at(30));
    const res = await send("PATCH", `/events/${e.id}/capacity`, admin.clerkUserId, {
      body: { capacity: 2 },
    });
    expect(res.status).toBe(200);

    const rows = await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id));
    const m2Row = rows.find((r) => r.memberId === m2.id);
    expect(m2Row?.status).toBe("confirmed");

    const m2Entries = await t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, m2.id));
    expect(m2Entries.reduce((s, x) => s + x.amountSek, 0)).toBe(120);

    const m2Notes = await t.db.select().from(notification).where(eq(notification.memberId, m2.id));
    expect(m2Notes.some((n) => n.title === "You're in")).toBe(true);
  });
});
