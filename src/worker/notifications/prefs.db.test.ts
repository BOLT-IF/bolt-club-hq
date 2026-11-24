import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { member, notificationPref } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const env = { ENV: "test" } as unknown as Cloudflare.Env;

interface Prefs {
  globalMute: boolean;
  categories: { category: string; muted: boolean }[];
}

describe("notification preference routes", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-01T12:00:00Z"),
    });
  });
  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const get = (clerk?: string) =>
    routes.request(
      "/notifications/prefs",
      clerk ? { headers: { [TEST_IDENTITY_HEADER]: clerk } } : {},
      env,
    );
  const put = (clerk: string, body: unknown) =>
    routes.request(
      "/notifications/prefs",
      {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", [TEST_IDENTITY_HEADER]: clerk },
      },
      env,
    );
  const muted = (p: Prefs) => p.categories.filter((c) => c.muted).map((c) => c.category);

  it("requires a signed-in active member", async () => {
    expect((await get()).status).toBe(401);
    const pending = await makeMember(t.db, { status: "pending" });
    expect((await get(pending.clerkUserId)).status).toBe(403);
    expect((await put(pending.clerkUserId, { globalMute: true })).status).toBe(403);
  });

  it("everything is on by default; admin_tasks is listed for admins only", async () => {
    const m = await makeMember(t.db);
    const a = await makeMember(t.db, { role: "admin" });
    const mine = await (await get(m.clerkUserId)).json<Prefs>();
    expect(mine.globalMute).toBe(false);
    expect(mine.categories.map((c) => c.category)).toEqual([
      "rsvp_status",
      "event_changes",
      "new_events",
      "payment_due",
      "payment_status",
      "polls",
      "announcements",
    ]);
    expect(muted(mine)).toEqual([]);
    const admin = await (await get(a.clerkUserId)).json<Prefs>();
    expect(admin.categories.map((c) => c.category)).toContain("admin_tasks");
  });

  it("saves category mutes and the global mute, and reads them back", async () => {
    const m = await makeMember(t.db);
    const res = await put(m.clerkUserId, {
      globalMute: true,
      categories: { rsvp_status: true, polls: true },
    });
    expect(res.status).toBe(200);
    const saved = await res.json<Prefs>();
    expect(saved.globalMute).toBe(true);
    expect(muted(saved)).toEqual(["rsvp_status", "polls"]);
    expect(await (await get(m.clerkUserId)).json()).toEqual(saved);
    const [row] = await t.db.select().from(member).where(eq(member.id, m.id));
    expect(row?.globalMute).toBe(true);
  });

  it("unmuting updates the row in place, and a partial update keeps the rest", async () => {
    const m = await makeMember(t.db);
    await put(m.clerkUserId, { categories: { rsvp_status: true, polls: true } });
    const res = await put(m.clerkUserId, { categories: { polls: false } });
    expect(muted(await res.json<Prefs>())).toEqual(["rsvp_status"]);
    expect(await t.db.select().from(notificationPref)).toHaveLength(2);
  });

  it("only touches the caller's own preferences", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await put(a.clerkUserId, { globalMute: true, categories: { polls: true } });
    const other = await (await get(b.clerkUserId)).json<Prefs>();
    expect(other.globalMute).toBe(false);
    expect(muted(other)).toEqual([]);
  });

  it("rejects bad input and changes nothing", async () => {
    const m = await makeMember(t.db);
    for (const body of [
      {},
      { globalMute: "yes" },
      { categories: { nope: true } },
      { categories: { polls: "true" } },
      { categories: [] },
      // admin_tasks does not exist for a non-admin
      { categories: { admin_tasks: true } },
    ]) {
      expect((await put(m.clerkUserId, body)).status).toBe(400);
    }
    expect(await t.db.select().from(notificationPref)).toHaveLength(0);
  });

  it("an admin can mute admin_tasks", async () => {
    const a = await makeMember(t.db, { role: "admin" });
    const res = await put(a.clerkUserId, { categories: { admin_tasks: true } });
    expect(res.status).toBe(200);
    expect(muted(await res.json<Prefs>())).toEqual(["admin_tasks"]);
  });
});
