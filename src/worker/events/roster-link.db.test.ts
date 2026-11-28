import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { clubSettings, guest, member, rsvp } from "../../../db/schema";
import { decodeRosterImportFragment } from "../../domain/roster-link";
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

const NOW = "2027-03-10T12:00:00Z";
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const HOUR = 3_600_000;
const at = (hoursFromNow: number): Date => new Date(new Date(NOW).getTime() + hoursFromNow * HOUR);

describe("roster-link route (S8.3)", () => {
  let t: TestDatabase;
  let seq = 0;

  const app = () =>
    new Hono<AppEnv>()
      .use("*", requestIdMiddleware({ now: () => new Date(NOW).getTime() }))
      .route("/", eventsRoutes);

  const get = (path: string, clerkUserId: string) =>
    app().request(path, { headers: { [TEST_IDENTITY_HEADER]: clerkUserId } }, testEnv);

  beforeEach(async () => {
    t = await createTestDatabase();
    seq = 0;
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
    configureEventsDeps({ publishOg: () => new FakePublishOg() });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureEventsDeps({});
    await t.close();
  });

  it("denies regular members (403) and allows organizers/admins", async () => {
    const admin = await makeMember(t.db, { role: "admin", displayName: "Admin User" });
    const organizer = await makeMember(t.db, { role: "member", displayName: "Organizer User" });
    const regular = await makeMember(t.db, { role: "member", displayName: "Regular Member" });

    const created = await createEvent(
      { db: t.db, clock: new FixedClock(NOW), publishOg: new FakePublishOg() },
      {
        kind: "member_oneoff",
        createdBy: organizer.id,
        title: "Member One-Off",
        format: "Mixed Doubles",
        startsAt: at(4),
        endsAt: at(6),
        capacity: 12,
        adhocFee: 0,
        rsvpCloseAt: at(-1),
        allocationMode: "instant",
        status: "closed",
      },
    );

    const rMember = await get(`/events/${created.id}/roster-link`, regular.clerkUserId);
    expect(rMember.status).toBe(403);

    const rOrganizer = await get(`/events/${created.id}/roster-link`, organizer.clerkUserId);
    expect(rOrganizer.status).toBe(200);

    const rAdmin = await get(`/events/${created.id}/roster-link`, admin.clerkUserId);
    expect(rAdmin.status).toBe(200);
  });

  it("returns url: null when roster_app_url is unset, and builds the deep link when set", async () => {
    const admin = await makeMember(t.db, { role: "admin", displayName: "Admin User" });
    const m1 = await makeMember(t.db, { displayName: "Tove Sandqvist" });
    await t.db.update(member).set({ rosterName: "Sandy" }).where(eq(member.id, m1.id));
    const m2 = await makeMember(t.db, { displayName: "Kasia Nowak" });
    const mWait = await makeMember(t.db, { displayName: "Waitlisted Person" });

    const created = await createEvent(
      { db: t.db, clock: new FixedClock(NOW), publishOg: new FakePublishOg() },
      {
        kind: "admin_oneoff",
        createdBy: admin.id,
        title: "Sat Social Doubles",
        format: "Men's Doubles",
        startsAt: at(4),
        endsAt: at(6),
        capacity: 12,
        adhocFee: 0,
        rsvpCloseAt: at(-1),
        allocationMode: "tiered",
        status: "closed",
      },
    );

    const rsvp1Id = `rsvp_${String(++seq)}`;
    const rsvp2Id = `rsvp_${String(++seq)}`;
    const rsvpWaitId = `rsvp_${String(++seq)}`;
    await t.db.insert(rsvp).values([
      {
        id: rsvp2Id,
        eventId: created.id,
        memberId: m2.id,
        status: "confirmed",
        tier: 2,
        requestedAt: at(-5),
        confirmedAt: at(-1),
      },
      {
        id: rsvp1Id,
        eventId: created.id,
        memberId: m1.id,
        status: "confirmed",
        tier: 1,
        requestedAt: at(-4),
        confirmedAt: at(-3),
      },
      {
        id: rsvpWaitId,
        eventId: created.id,
        memberId: mWait.id,
        status: "waitlisted",
        tier: 2,
        requestedAt: at(-6),
        confirmedAt: null,
      },
    ]);
    await t.db.insert(guest).values({
      id: `gst_${String(++seq)}`,
      rsvpId: rsvp1Id,
      name: "Hugo Dahl",
      status: "confirmed",
      tier: 3,
      requestedAt: at(-4),
    });

    const unsetRes = await get(`/events/${created.id}/roster-link`, admin.clerkUserId);
    expect(unsetRes.status).toBe(200);
    const unsetBody = await unsetRes.json<{
      rosterAppUrl: string | null;
      url: string | null;
      textList: string;
      players: Array<{ name: string; short: string; guest: boolean }>;
    }>();
    expect(unsetBody.rosterAppUrl).toBeNull();
    expect(unsetBody.url).toBeNull();
    expect(unsetBody.players).toEqual([
      { name: "Tove Sandqvist", short: "Sandy", guest: false },
      { name: "Kasia Nowak", short: "Kasia", guest: false },
      { name: "Hugo Dahl", short: "Hugo", guest: true },
    ]);
    expect(unsetBody.textList).toBe("Tove Sandqvist\nKasia Nowak\nHugo Dahl");

    await t.db
      .insert(clubSettings)
      .values({
        id: 1,
        clubName: "BOLT",
        bankDetails: "{}",
        paymentInstructions: "Pay",
        quietHours: { start: "22:00", end: "07:00" },
        defaults: {},
        accountingAccountCodes: {},
        rosterAppUrl: "https://roster.example.se",
      })
      .onConflictDoUpdate({
        target: clubSettings.id,
        set: { rosterAppUrl: "https://roster.example.se" },
      });

    const setRes = await get(`/events/${created.id}/roster-link`, admin.clerkUserId);
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json<{
      rosterAppUrl: string | null;
      url: string | null;
      textList: string;
      players: Array<{ name: string; short: string; guest: boolean }>;
    }>();
    expect(setBody.rosterAppUrl).toBe("https://roster.example.se");
    expect(setBody.url).toMatch(/^https:\/\/roster\.example\.se\/planner#import=/);
    const decoded = decodeRosterImportFragment(setBody.url!.split("#import=")[1]!);
    expect(decoded.players).toEqual(setBody.players);
  });
});
