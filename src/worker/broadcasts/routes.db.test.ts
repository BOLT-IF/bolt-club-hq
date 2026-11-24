import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, notification } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const env = { ENV: "test" } as unknown as Cloudflare.Env;

describe("POST /admin/broadcasts", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-05T10:00:00Z"),
    });
  });
  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const send = (clerk: string | null, body: unknown, key: string | null = "k1") =>
    routes.request(
      "/admin/broadcasts",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          ...(clerk ? { [TEST_IDENTITY_HEADER]: clerk } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
      },
      env,
    );
  const valid = { title: "Hall closed", body: "No play", audience: { kind: "all" } };

  it("is admin only: 401 signed out, 403 for a member", async () => {
    const m = await makeMember(t.db);
    expect((await send(null, valid)).status).toBe(401);
    expect((await send(m.clerkUserId, valid)).status).toBe(403);
    expect(await t.db.select().from(notification)).toHaveLength(0);
  });

  it("requires an Idempotency-Key", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    expect((await send(admin.clerkUserId, valid, null)).status).toBe(400);
  });

  it("sends, audits, and returns the recipient count", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await makeMember(t.db);
    const res = await send(admin.clerkUserId, valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recipientCount: 2 });
    expect(await t.db.select().from(notification)).toHaveLength(2);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: admin.id, action: "broadcast.send" });
  });

  it("a replay with the same key does not send twice", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await makeMember(t.db);
    await send(admin.clerkUserId, valid, "same");
    const again = await send(admin.clerkUserId, valid, "same");
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await t.db.select().from(notification)).toHaveLength(2);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it("400 on a bad body, 404 on an unknown event", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    expect(
      (await send(admin.clerkUserId, { title: "", body: "x", audience: { kind: "all" } })).status,
    ).toBe(400);
    const res = await send(
      admin.clerkUserId,
      { title: "x", body: "y", audience: { kind: "event_rsvps", eventId: "nope" } },
      "k2",
    );
    expect(res.status).toBe(404);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
