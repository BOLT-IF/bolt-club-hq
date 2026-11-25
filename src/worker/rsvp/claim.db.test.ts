import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clubSettings, ledgerEntry, notification, rsvp, series, term } from "../../../db/schema";
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
import claimRoutes from "./claim";
import { closeEvent } from "./close";
import { configureRsvpDeps } from "./deps";
import postcloseRoutes from "./postclose";
import rsvpRoutes from "./routes";

const NOW = "2027-04-01T12:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(new Date(NOW).getTime() + hours * HOUR);
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

describe("claim-a-spot (S4.4b)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let prepaid: FakePrepaid;
  let keySeq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => clock.now().getTime() }))
      .route("/", rsvpRoutes)
      .route("/", postcloseRoutes)
      .route("/", claimRoutes);

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
        title: "Thursday Mixed",
        format: "mixed",
        startsAt: at(48),
        endsAt: at(50),
        location: "Hall X",
        capacity: 1,
        adhocFee: 120,
        maxGuestsPerMember: 2,
        rsvpCloseAt: at(24),
        allocationMode: "tiered",
        ...over,
      },
    );
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

  it("in a race between two claims, exactly one wins", async () => {
    const e = await addEvent({ capacity: 1 });
    const host = await makeMember(t.db);
    const w1 = await makeMember(t.db);
    const w2 = await makeMember(t.db);

    await send("PUT", `/events/${e.id}/rsvp`, host.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, w1.clerkUserId, { body: { guests: [] } });
    clock.advance(1000);
    await send("PUT", `/events/${e.id}/rsvp`, w2.clerkUserId, { body: { guests: [] } });

    // Close event: host confirmed, w1 & w2 waitlisted.
    clock.set(at(25));
    await closeEvent(t.db, clock, e.id);

    // Move inside 3h cutoff (startsAt is at +48h; +46h is 2h before start).
    // Host late-cancels -> both w1 and w2 become "offered".
    clock.set(at(46));
    const cancelRes = await send("POST", `/events/${e.id}/rsvp/late-cancel`, host.clerkUserId, {
      body: {},
    });
    expect(cancelRes.status).toBe(200);

    // Both w1 and w2 race to claim the single freed spot concurrently.
    const [res1, res2] = await Promise.all([
      send("POST", `/events/${e.id}/claim`, w1.clerkUserId, { body: {} }),
      send("POST", `/events/${e.id}/claim`, w2.clerkUserId, { body: {} }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const confirmedRows = (await t.db.select().from(rsvp).where(eq(rsvp.eventId, e.id))).filter(
      (row) => row.status === "confirmed",
    );
    expect(confirmedRows).toHaveLength(1);

    // Winner was charged, and host's late-cancel was refilled (reversed).
    const winnerId = confirmedRows[0]!.memberId;
    const winnerEntries = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, winnerId));
    expect(winnerEntries.reduce((s, x) => s + x.amountSek, 0)).toBe(120);

    const hostEntries = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, host.id));
    expect(hostEntries.reduce((s, x) => s + x.amountSek, 0)).toBe(0);

    const hostNotes = await t.db
      .select()
      .from(notification)
      .where(eq(notification.memberId, host.id));
    expect(hostNotes.some((n) => n.title === "Spot refilled")).toBe(true);
  });

  it("rejects claim when member is not offered", async () => {
    const e = await addEvent({ capacity: 1 });
    const m = await makeMember(t.db);
    clock.set(at(25));
    await closeEvent(t.db, clock, e.id);

    const res = await send("POST", `/events/${e.id}/claim`, m.clerkUserId, { body: {} });
    expect(res.status).toBe(409);
  });
});
