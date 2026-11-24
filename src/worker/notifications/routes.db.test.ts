import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { notification } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const env = { ENV: "test" } as unknown as Cloudflare.Env;

interface Item {
  id: string;
  title: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
interface List {
  items: Item[];
  unreadCount: number;
}

describe("notification routes", () => {
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

  const as = (clerk: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      [TEST_IDENTITY_HEADER]: clerk,
    },
  });
  const post = (clerk: string, body: unknown) =>
    routes.request(
      "/notifications/read",
      as(clerk, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      env,
    );
  const list = async (clerk: string, query = "") =>
    (await (await routes.request(`/notifications${query}`, as(clerk), env)).json()) as List;

  async function seed(memberId: string, n: number, prefix: string) {
    for (let i = 1; i <= n; i++) {
      await t.db.insert(notification).values({
        id: `${prefix}${String(i)}`,
        memberId,
        category: "rsvp_status",
        title: `${prefix} ${String(i)}`,
        body: "b",
        link: "/events",
        createdAt: new Date(`2027-01-01T0${String(i)}:00:00Z`),
        idempotencyKey: `${prefix}-key-${String(i)}`,
      });
    }
  }

  it("requires a signed-in active member", async () => {
    expect((await routes.request("/notifications", {}, env)).status).toBe(401);
    expect((await post("nobody", { all: true })).status).toBe(401);
    const pending = await makeMember(t.db, { status: "pending" });
    expect((await routes.request("/notifications", as(pending.clerkUserId), env)).status).toBe(403);
  });

  it("members see only their own notifications, newest first", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await seed(a.id, 3, "a");
    await seed(b.id, 2, "b");
    const body = await list(a.clerkUserId);
    expect(body.items.map((i) => i.id)).toEqual(["a3", "a2", "a1"]);
    expect(body.unreadCount).toBe(3);
    expect((await list(b.clerkUserId)).items.map((i) => i.id)).toEqual(["b2", "b1"]);
  });

  it("limits the page size", async () => {
    const a = await makeMember(t.db);
    await seed(a.id, 3, "a");
    const body = await list(a.clerkUserId, "?limit=2");
    expect(body.items).toHaveLength(2);
    expect(body.unreadCount).toBe(3);
  });

  it("marks chosen notifications read, using the injected clock", async () => {
    const a = await makeMember(t.db);
    await seed(a.id, 3, "a");
    const res = await post(a.clerkUserId, { ids: ["a1", "a2"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    const body = await list(a.clerkUserId);
    expect(body.unreadCount).toBe(1);
    expect(body.items.find((i) => i.id === "a1")?.readAt).toBe("2027-01-01T12:00:00.000Z");
  });

  it("marks everything read with all:true", async () => {
    const a = await makeMember(t.db);
    await seed(a.id, 3, "a");
    expect(await (await post(a.clerkUserId, { all: true })).json()).toEqual({ updated: 3 });
    expect((await list(a.clerkUserId)).unreadCount).toBe(0);
  });

  it("cannot mark another member's notifications read", async () => {
    const a = await makeMember(t.db);
    const b = await makeMember(t.db);
    await seed(b.id, 2, "b");
    expect(await (await post(a.clerkUserId, { ids: ["b1", "b2"] })).json()).toEqual({ updated: 0 });
    expect((await list(b.clerkUserId)).unreadCount).toBe(2);
  });

  it("does not re-stamp an already read notification", async () => {
    const a = await makeMember(t.db);
    await seed(a.id, 1, "a");
    await post(a.clerkUserId, { ids: ["a1"] });
    expect(await (await post(a.clerkUserId, { ids: ["a1"] })).json()).toEqual({ updated: 0 });
  });

  it("rejects a body that names neither ids nor all", async () => {
    const a = await makeMember(t.db);
    expect((await post(a.clerkUserId, {})).status).toBe(400);
    expect((await post(a.clerkUserId, { ids: "a1" })).status).toBe(400);
  });
});
