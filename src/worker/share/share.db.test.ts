import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app";
import { configureRequestDeps } from "../core/context";
import { FixedClock } from "../core/clock";
import { createTestDb, type TestDb } from "../test-support/database";
import { insertEvent, insertMember, insertSeries } from "../test-support/factories";

const NOW = new Date("2027-03-10T12:00:00.000Z");

describe("share routes DB fallback (S7.1)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock(NOW),
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  it("falls back to Neon on KV miss and returns 404 for unknown slug", async () => {
    const admin = await insertMember(t.db, { role: "admin" });
    const created = await insertEvent(t.db, {
      createdBy: admin.id,
      title: "Postgres Event",
      location: "Hall P",
      startsAt: new Date("2027-03-15T18:00:00.000Z"),
      endsAt: new Date("2027-03-15T19:30:00.000Z"),
      rsvpCloseAt: new Date("2027-03-15T17:00:00.000Z"),
    });

    const app = createApp();
    const hit = await app.request(
      `https://club.example/e/${created.shareSlug}`,
      undefined,
      { ENV: "test" } as unknown as Cloudflare.Env,
    );
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("Postgres Event");

    const miss = await app.request(
      "https://club.example/e/unknownslug999",
      undefined,
      { ENV: "test" } as unknown as Cloudflare.Env,
    );
    expect(miss.status).toBe(404);
  });

  it("/s/:slug resolves the series next open event from Neon and 404s on unknown series", async () => {
    const admin = await insertMember(t.db, { role: "admin" });
    const ser = await insertSeries(t.db, { title: "Thursday Club", shareSlug: "thu-club" });
    await insertEvent(t.db, {
      createdBy: admin.id,
      seriesId: ser.id,
      kind: "series",
      title: "Thursday Club #4",
      location: "Hall T",
      startsAt: new Date("2027-03-18T18:00:00.000Z"),
      endsAt: new Date("2027-03-18T19:30:00.000Z"),
      rsvpCloseAt: new Date("2027-03-18T17:00:00.000Z"),
    });

    const app = createApp();
    const hit = await app.request(
      "https://club.example/s/thu-club",
      undefined,
      { ENV: "test" } as unknown as Cloudflare.Env,
    );
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("Thursday Club #4");

    const miss = await app.request(
      "https://club.example/s/no-such-series",
      undefined,
      { ENV: "test" } as unknown as Cloudflare.Env,
    );
    expect(miss.status).toBe(404);
  });
});
