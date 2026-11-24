import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { auditLog, invite } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { mountBackendRoutes } from "../registry";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const NOW = "2027-03-01T09:00:00.000Z";
const DAY = 86_400_000;

type Row = Awaited<ReturnType<typeof makeMember>>;

interface InviteJson {
  id: string;
  token: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  state: string;
}

describe("invites (S1.3)", () => {
  let t: TestDatabase;
  const app = new Hono<AppEnv>();
  mountBackendRoutes(app);

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  function call(as: Row | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(
      `/api/v1${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      testEnv,
    );
  }

  it("an admin creates an invite with expiry and max uses, audited", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await call(admin, "POST", "/invites", { expiresInDays: 7, maxUses: 3 });
    expect(res.status).toBe(201);
    const { invite: created } = await res.json<{ invite: InviteJson }>();
    expect(created.token).toMatch(/^[a-z2-9]{24}$/);
    expect(created.maxUses).toBe(3);
    expect(created.uses).toBe(0);
    expect(created.state).toBe("active");
    expect(new Date(created.expiresAt).getTime()).toBe(new Date(NOW).getTime() + 7 * DAY);
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, created.id));
    expect(audits.map((a) => a.action)).toEqual(["invite.create"]);
  });

  it("uses defaults and rejects out-of-range values", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await call(admin, "POST", "/invites", {});
    expect(res.status).toBe(201);
    const { invite: created } = await res.json<{ invite: InviteJson }>();
    expect(created.maxUses).toBe(10);
    expect(new Date(created.expiresAt).getTime()).toBe(new Date(NOW).getTime() + 14 * DAY);
    for (const body of [
      { maxUses: 0 },
      { maxUses: 1.5 },
      { expiresInDays: 0 },
      { expiresInDays: 91 },
    ]) {
      expect((await call(admin, "POST", "/invites", body)).status).toBe(400);
    }
  });

  it("invites are admin only", async () => {
    const plain = await makeMember(t.db);
    const pending = await makeMember(t.db, { status: "pending" });
    expect((await call(plain, "POST", "/invites", {})).status).toBe(403);
    expect((await call(plain, "GET", "/invites")).status).toBe(403);
    expect((await call(pending, "GET", "/invites")).status).toBe(403);
    expect((await call(null, "GET", "/invites")).status).toBe(401);
  });

  it("lists invites newest first with their state", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await t.db.insert(invite).values([
      {
        id: "inv_old",
        token: "old",
        createdBy: admin.id,
        expiresAt: new Date(new Date(NOW).getTime() - DAY),
        maxUses: 5,
      },
      {
        id: "inv_full",
        token: "full",
        createdBy: admin.id,
        expiresAt: new Date(new Date(NOW).getTime() + DAY),
        maxUses: 2,
        uses: 2,
      },
    ]);
    const res = await call(admin, "GET", "/invites");
    expect(res.status).toBe(200);
    const { invites } = await res.json<{ invites: InviteJson[] }>();
    const byId = Object.fromEntries(invites.map((i) => [i.id, i.state]));
    expect(byId).toEqual({ inv_old: "expired", inv_full: "used_up" });
  });

  it("revoking stamps revoked_at once and is audited once", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const created = await (
      await call(admin, "POST", "/invites", {})
    ).json<{ invite: InviteJson }>();
    const first = await call(admin, "DELETE", `/invites/${created.invite.id}`);
    expect(first.status).toBe(200);
    expect((await first.json<{ invite: InviteJson }>()).invite.state).toBe("revoked");
    expect((await call(admin, "DELETE", `/invites/${created.invite.id}`)).status).toBe(200);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, created.invite.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["invite.create", "invite.revoke"]);
    expect((await call(admin, "DELETE", "/invites/nope")).status).toBe(404);
  });
});
