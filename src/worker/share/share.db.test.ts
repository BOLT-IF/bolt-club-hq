import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { event, series, term } from "../../../db/schema";
import { createApp } from "../app";
import { FixedClock } from "../core/clock";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { configureShareDeps } from "./deps";

const NOW = new Date("2027-03-10T12:00:00.000Z");

describe("share routes DB fallback (S7.1)", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureShareDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock(NOW),
    });
  });

  afterEach(async () => {
    configureShareDeps({});
    await t.close();
  });

  it("falls back to Neon on KV miss and returns 404 for unknown slug", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const [created] = await t.db
      .insert(event)
      .values({
        id: "evt_share_db_1",
        shareSlug: "pgshare1",
        kind: "admin_oneoff",
        createdBy: admin.id,
        title: "Postgres Event",
        format: "Mixed Doubles",
        startsAt: new Date("2027-03-15T18:00:00.000Z"),
        endsAt: new Date("2027-03-15T19:30:00.000Z"),
        location: "Hall P",
        capacity: 12,
        adhocFee: 0,
        maxGuestsPerMember: 1,
        rsvpCloseAt: new Date("2027-03-15T17:00:00.000Z"),
        allocationMode: "tiered",
        status: "scheduled",
      })
      .returning();

    const app = createApp();
    const hit = await app.request(`https://club.example/e/${created!.shareSlug}`, undefined, {
      ENV: "test",
    });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("Postgres Event");

    const miss = await app.request("https://club.example/e/unknownslug999", undefined, {
      ENV: "test",
    });
    expect(miss.status).toBe(404);
  });

  it("/s/:slug resolves the series next open event from Neon and 404s on unknown series", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await t.db.insert(term).values({
      id: "term_share_1",
      name: "Spring 2027",
      startsOn: "2027-01-01",
      endsOn: "2027-06-30",
      status: "active",
    });
    const [ser] = await t.db
      .insert(series)
      .values({
        id: "ser_share_db_1",
        termId: "term_share_1",
        name: "Thursday Club",
        format: "Mixed Doubles",
        weekday: 4,
        startTime: "19:00",
        durationMin: 90,
        location: "Hall T",
        capacity: 16,
        passCap: 12,
        passPrice: 500,
        adhocFee: 60,
        maxGuestsDefault: 1,
        rsvpCloseOffsetMin: 60,
        shareSlug: "thu-club",
      })
      .returning();
    await t.db.insert(event).values({
      id: "evt_share_db_2",
      seriesId: ser!.id,
      shareSlug: "thu4slug",
      kind: "series",
      createdBy: admin.id,
      title: "Thursday Club #4",
      format: "Mixed Doubles",
      startsAt: new Date("2027-03-18T18:00:00.000Z"),
      endsAt: new Date("2027-03-18T19:30:00.000Z"),
      location: "Hall T",
      capacity: 16,
      adhocFee: 60,
      maxGuestsPerMember: 1,
      rsvpCloseAt: new Date("2027-03-18T17:00:00.000Z"),
      allocationMode: "tiered",
      status: "scheduled",
    });

    const app = createApp();
    const hit = await app.request("https://club.example/s/thu-club", undefined, {
      ENV: "test",
    });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("Thursday Club #4");

    const miss = await app.request("https://club.example/s/no-such-series", undefined, {
      ENV: "test",
    });
    expect(miss.status).toBe(404);
  });
});
