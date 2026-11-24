import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { seriesCaptain, series, term } from "../../../db/schema";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import { FixedClock } from "./clock";
import { configureRequestDeps, contextMiddleware } from "./context";
import { requireGuard } from "./permissions";
import { TEST_IDENTITY_HEADER } from "./test-identity";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

function app() {
  return new Hono<AppEnv>()
    .use("*", contextMiddleware())
    .get("/me", (c) => c.json({ actor: c.var.actor, now: c.var.clock.now().toISOString() }))
    .get("/admin", requireGuard("admin"), (c) => c.json({ ok: true }));
}

describe("request context (W2 contract)", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-01T10:00:00Z"),
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  it("resolves the test identity to the member, with captained series", async () => {
    const m = await makeMember(t.db, { role: "member" });
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-01" });
    await t.db.insert(series).values({
      id: "s1",
      termId: "t1",
      name: "Mon",
      format: "open",
      weekday: 1,
      startTime: "19:00",
      durationMin: 90,
      capacity: 12,
      passPrice: 1200,
      adhocFee: 120,
      shareSlug: "slug-s1-abcdefgh",
      passCap: 10,
    });
    await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: m.id });

    const res = await app().request(
      "/me",
      { headers: { [TEST_IDENTITY_HEADER]: m.clerkUserId } },
      testEnv,
    );
    const body = await res.json<{ actor: { id: string; seriesIds: string[] }; now: string }>();
    expect(body.actor.id).toBe(m.id);
    expect(body.actor.seriesIds).toEqual(["s1"]);
    expect(body.now).toBe("2027-01-01T10:00:00.000Z");
  });

  it("no identity means actor null and guards answer 401", async () => {
    expect(
      (await (await app().request("/me", {}, testEnv)).json<{ actor: unknown }>()).actor,
    ).toBeNull();
    expect((await app().request("/admin", {}, testEnv)).status).toBe(401);
  });

  it("an admin passes the admin guard, a member gets 403", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const plain = await makeMember(t.db);
    const as = (clerk: string) => ({ headers: { [TEST_IDENTITY_HEADER]: clerk } });
    expect((await app().request("/admin", as(admin.clerkUserId), testEnv)).status).toBe(200);
    expect((await app().request("/admin", as(plain.clerkUserId), testEnv)).status).toBe(403);
  });
});
