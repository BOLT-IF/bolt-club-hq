import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import {
  auditLog,
  event,
  invite,
  joinRequest,
  member,
  notification,
  series,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { mountBackendRoutes } from "../registry";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeLedgerEntry, makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const NOW = "2027-03-01T09:00:00.000Z";
const DAY = 86_400_000;
const at = (days: number) => new Date(new Date(NOW).getTime() + days * DAY);

type Row = Awaited<ReturnType<typeof makeMember>>;

/** Routes a pending member may call: who am I, the public config, and the join flow itself. */
const PENDING_ALLOWED = new Set([
  "GET /api/v1/me",
  "GET /api/v1/config",
  "GET /api/v1/probe",
  "GET /api/v1/join-requests/mine",
  "POST /api/v1/join-requests",
]);

describe("join requests and approval (S1.3)", () => {
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
      path.startsWith("/api/v1") ? path : `/api/v1${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      testEnv,
    );
  }

  async function addInvite(createdBy: string, over: Partial<typeof invite.$inferInsert> = {}) {
    const id = over.id ?? `inv_${crypto.randomUUID()}`;
    await t.db.insert(invite).values({
      id,
      token: `tok-${id}`,
      createdBy,
      expiresAt: at(7),
      maxUses: 5,
      ...over,
    });
    return { id, token: over.token ?? `tok-${id}` };
  }

  async function addEvent(createdBy: string) {
    await t.db
      .insert(term)
      .values({ id: "t1", name: "Spring", startsOn: "2027-01-01", endsOn: "2027-06-01" });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "t1",
      name: "Thursday open",
      format: "open",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 12,
      passPrice: 1200,
      adhocFee: 120,
      shareSlug: "seriesslug",
      passCap: 10,
    });
    await t.db.insert(event).values({
      id: "evt_1",
      seriesId: "ser_1",
      kind: "series",
      createdBy,
      title: "Thu open",
      format: "open",
      startsAt: at(2),
      endsAt: at(2.1),
      capacity: 12,
      adhocFee: 120,
      rsvpCloseAt: at(1),
      allocationMode: "tiered",
      shareSlug: "eventslug1",
    });
  }

  const requestsOf = (memberId: string) =>
    t.db.select().from(joinRequest).where(eq(joinRequest.memberId, memberId));
  const adminTasks = () =>
    t.db.select().from(notification).where(eq(notification.category, "admin_tasks"));

  describe("pending members are walled off", () => {
    it("a pending member can't RSVP or see members, attendees or the ledger", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const pending = await makeMember(t.db, { status: "pending" });
      await addEvent(admin.id);
      await makeLedgerEntry(t.db, pending.id, { amountSek: 100 });

      for (const path of [
        "/members",
        "/events",
        "/events/evt_1",
        "/events/by-slug/eventslug1",
        "/me/ledger",
        "/me/profile",
      ]) {
        expect((await call(pending, "GET", path)).status, path).toBe(403);
      }
      // RSVP (S4.2) sits behind the same member guard: PUT /events/:id/rsvp is refused.
      const rsvp = await call(pending, "PUT", "/events/evt_1/rsvp", { guests: [] });
      expect([403, 404]).toContain(rsvp.status);
    });

    it("every API route refuses a pending member except the join flow (sweep)", async () => {
      const pending = await makeMember(t.db, { status: "pending" });
      const seen = new Set<string>();
      const offenders: string[] = [];
      for (const route of app.routes) {
        if (route.method === "ALL" || route.path.includes("*")) continue;
        if (!route.path.startsWith("/api/v1")) continue;
        const key = `${route.method} ${route.path}`;
        if (seen.has(key) || PENDING_ALLOWED.has(key)) continue;
        seen.add(key);
        const path = route.path.replace(/:[^/]+/g, "x");
        const res = await call(pending, route.method, path, route.method === "GET" ? undefined : {});
        if (res.status !== 403) offenders.push(`${key} -> ${String(res.status)}`);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("creating a request", () => {
    it("via a valid invite: records the source, consumes one use, notifies every admin once", async () => {
      const a1 = await makeMember(t.db, { role: "admin" });
      const a2 = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin", status: "inactive" });
      await makeMember(t.db); // plain member: never gets admin_tasks
      const inv = await addInvite(a1.id);
      const pending = await makeMember(t.db, { status: "pending", displayName: "Nina New" });

      const res = await call(pending, "POST", "/join-requests", { via: "invite", token: inv.token });
      expect(res.status).toBe(201);
      const { request } = await res.json<{ request: { id: string; via: string } }>();
      expect(request.via).toBe("invite");

      const [stored] = await requestsOf(pending.id);
      expect(stored?.sourceId).toBe(inv.id);
      const [inviteRow] = await t.db.select().from(invite).where(eq(invite.id, inv.id));
      expect(inviteRow?.uses).toBe(1);

      const tasks = await adminTasks();
      expect(tasks.map((n) => n.memberId).sort()).toEqual([a1.id, a2.id].sort());
      expect(tasks.every((n) => n.link === "/admin/approvals")).toBe(true);
      expect(tasks[0]?.body).toContain("Nina New");

      const audits = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entity, "join_request"), eq(auditLog.entityId, request.id)));
      expect(audits.map((x) => x.action)).toEqual(["join_request.create"]);
    });

    it("admins are notified exactly once: a repeat request returns the open one", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const inv = await addInvite(admin.id);
      const pending = await makeMember(t.db, { status: "pending" });

      const first = await call(pending, "POST", "/join-requests", { via: "invite", token: inv.token });
      const again = await call(pending, "POST", "/join-requests", { via: "invite", token: inv.token });
      const [r1, r2] = await Promise.all([
        call(pending, "POST", "/join-requests", { via: "invite", token: inv.token }),
        call(pending, "POST", "/join-requests", { via: "invite", token: inv.token }),
      ]);
      expect(first.status).toBe(201);
      expect([again.status, r1.status, r2.status]).toEqual([200, 200, 200]);

      expect(await requestsOf(pending.id)).toHaveLength(1);
      expect(await adminTasks()).toHaveLength(1);
      const [inviteRow] = await t.db.select().from(invite).where(eq(invite.id, inv.id));
      expect(inviteRow?.uses).toBe(1);
    });

    it("a revoked or expired invite is refused", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const revoked = await addInvite(admin.id, { revokedAt: at(-1) });
      const expired = await addInvite(admin.id, { expiresAt: at(-0.001) });
      const exactlyNow = await addInvite(admin.id, { expiresAt: at(0) });
      const usedUp = await addInvite(admin.id, { maxUses: 2, uses: 2 });
      const pending = await makeMember(t.db, { status: "pending" });

      const expectRefused = async (token: string, error: string) => {
        const res = await call(pending, "POST", "/join-requests", { via: "invite", token });
        expect(res.status, error).toBe(410);
        expect((await res.json<{ error: string }>()).error).toBe(error);
      };
      await expectRefused(revoked.token, "invite_revoked");
      await expectRefused(expired.token, "invite_expired");
      await expectRefused(exactlyNow.token, "invite_expired");
      await expectRefused(usedUp.token, "invite_used_up");
      const unknown = await call(pending, "POST", "/join-requests", { via: "invite", token: "nope" });
      expect(unknown.status).toBe(404);

      expect(await requestsOf(pending.id)).toHaveLength(0);
      expect(await adminTasks()).toHaveLength(0);
    });

    it("the last use of an invite is handed out once under concurrency", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const inv = await addInvite(admin.id, { maxUses: 1 });
      const p1 = await makeMember(t.db, { status: "pending" });
      const p2 = await makeMember(t.db, { status: "pending" });
      const results = await Promise.all([
        call(p1, "POST", "/join-requests", { via: "invite", token: inv.token }),
        call(p2, "POST", "/join-requests", { via: "invite", token: inv.token }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    });

    it("via an event or series link records the event or series id", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await addEvent(admin.id);
      const p1 = await makeMember(t.db, { status: "pending" });
      const p2 = await makeMember(t.db, { status: "pending" });

      const e = await call(p1, "POST", "/join-requests", { via: "event_link", slug: "eventslug1" });
      const s = await call(p2, "POST", "/join-requests", { via: "series_link", slug: "seriesslug" });
      expect([e.status, s.status]).toEqual([201, 201]);
      expect((await requestsOf(p1.id))[0]?.sourceId).toBe("evt_1");
      expect((await requestsOf(p2.id))[0]?.sourceId).toBe("ser_1");

      const missing = await call(p1, "POST", "/join-requests", { via: "event_link", slug: "zzz" });
      expect(missing.status).toBe(200); // p1 already has an open request
      const p3 = await makeMember(t.db, { status: "pending" });
      expect(
        (await call(p3, "POST", "/join-requests", { via: "series_link", slug: "zzz" })).status,
      ).toBe(404);
      expect((await call(p3, "POST", "/join-requests", { via: "carrier_pigeon" })).status).toBe(400);
    });

    it("members, signed-out visitors and erased users can't file a request", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await addEvent(admin.id);
      const body = { via: "event_link", slug: "eventslug1" };
      expect((await call(null, "POST", "/join-requests", body)).status).toBe(401);
      expect((await call(admin, "POST", "/join-requests", body)).status).toBe(409);
      const erased = await makeMember(t.db, { status: "erased" });
      expect((await call(erased, "POST", "/join-requests", body)).status).toBe(403);
    });

    it("GET /join-requests/mine tells a pending member whether they are waiting", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await addEvent(admin.id);
      const pending = await makeMember(t.db, { status: "pending" });
      const before = await call(pending, "GET", "/join-requests/mine");
      expect(await before.json()).toEqual({ status: "pending", request: null });
      await call(pending, "POST", "/join-requests", { via: "event_link", slug: "eventslug1" });
      const after = await (await call(pending, "GET", "/join-requests/mine")).json<{
        status: string;
        request: { via: string; createdAt: string } | null;
      }>();
      expect(after.status).toBe("pending");
      expect(after.request?.via).toBe("event_link");
      expect(JSON.stringify(after)).not.toContain("evt_1");
      expect((await call(null, "GET", "/join-requests/mine")).status).toBe(401);
    });
  });

  describe("approval queue", () => {
    async function filed() {
      const admin = await makeMember(t.db, { role: "admin" });
      await addEvent(admin.id);
      const pending = await makeMember(t.db, { status: "pending", displayName: "Nina New" });
      const res = await call(pending, "POST", "/join-requests", {
        via: "event_link",
        slug: "eventslug1",
      });
      const { request } = await res.json<{ request: { id: string } }>();
      return { admin, pending, requestId: request.id };
    }

    it("lists pending requests with who and where from, admin only", async () => {
      const { admin, pending } = await filed();
      const res = await call(admin, "GET", "/admin/join-requests");
      expect(res.status).toBe(200);
      const { requests } = await res.json<{
        requests: Array<{ memberId: string; displayName: string; via: string; source: string | null }>;
      }>();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        memberId: pending.id,
        displayName: "Nina New",
        via: "event_link",
        source: "Thu open",
      });
      expect((await call(pending, "GET", "/admin/join-requests")).status).toBe(403);
      const plain = await makeMember(t.db);
      expect((await call(plain, "GET", "/admin/join-requests")).status).toBe(403);
    });

    it("approve activates the member once, sets joined_at and is audited", async () => {
      const { admin, pending, requestId } = await filed();
      const res = await call(admin, "POST", `/join-requests/${requestId}/approve`);
      expect(res.status).toBe(200);
      const [row] = await t.db.select().from(member).where(eq(member.id, pending.id));
      expect(row?.status).toBe("active");
      expect(row?.joinedAt?.toISOString()).toBe(NOW);
      expect((await call(admin, "POST", `/join-requests/${requestId}/approve`)).status).toBe(200);
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, pending.id), eq(auditLog.action, "member.approve")));
      expect(audits).toHaveLength(1);
      // The queue is empty and the member now passes the member guard.
      const queue = await (await call(admin, "GET", "/admin/join-requests")).json<{
        requests: unknown[];
      }>();
      expect(queue.requests).toHaveLength(0);
      expect((await call(pending, "GET", "/members")).status).toBe(200);
    });

    it("reject clears the request, keeps the member pending and is audited", async () => {
      const { admin, pending, requestId } = await filed();
      expect((await call(admin, "POST", `/join-requests/${requestId}/reject`)).status).toBe(200);
      const [row] = await t.db.select().from(member).where(eq(member.id, pending.id));
      expect(row?.status).toBe("pending");
      expect(await requestsOf(pending.id)).toHaveLength(0);
      expect((await call(admin, "POST", `/join-requests/${requestId}/reject`)).status).toBe(404);
      expect((await call(admin, "POST", `/join-requests/${requestId}/approve`)).status).toBe(404);
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, pending.id), eq(auditLog.action, "join_request.reject")));
      expect(audits).toHaveLength(1);
    });

    it("approve and reject are admin only; a non-pending member can't be approved", async () => {
      const { admin, pending, requestId } = await filed();
      const plain = await makeMember(t.db);
      expect((await call(plain, "POST", `/join-requests/${requestId}/approve`)).status).toBe(403);
      expect((await call(pending, "POST", `/join-requests/${requestId}/reject`)).status).toBe(403);
      await t.db.update(member).set({ status: "erased" }).where(eq(member.id, pending.id));
      expect((await call(admin, "POST", `/join-requests/${requestId}/approve`)).status).toBe(409);
    });
  });
});
