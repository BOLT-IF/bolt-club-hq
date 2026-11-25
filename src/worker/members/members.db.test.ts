import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { auditLog, member } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps, contextMiddleware } from "../core/context";
import { requireGuard } from "../core/permissions";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import routes from "./routes";
import { configureRsvpCancel } from "./rsvp-cancel";
import { FakeRsvpCancel } from "./rsvp-cancel.fake";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const NOW = "2027-03-01T09:00:00.000Z";

type Row = Awaited<ReturnType<typeof makeMember>>;

describe("members (S2.1)", () => {
  let t: TestDatabase;
  let rsvp: FakeRsvpCancel;

  beforeEach(async () => {
    t = await createTestDatabase();
    rsvp = new FakeRsvpCancel();
    configureRsvpCancel(rsvp);
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
  });

  afterEach(async () => {
    configureRequestDeps({});
    configureRsvpCancel(undefined);
    await t.close();
  });

  function call(as: Row | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return routes.request(
      path,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      testEnv,
    );
  }

  const reload = async (m: Row) => {
    const [row] = await t.db.select().from(member).where(eq(member.id, m.id));
    return row!;
  };
  const auditFor = (entityId: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.entityId, entityId));

  describe("lists", () => {
    it("the admin list shows every status with payment_ref, never the Clerk id", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { status: "pending" });
      await makeMember(t.db, { status: "inactive" });
      const res = await call(admin, "GET", "/admin/members");
      expect(res.status).toBe(200);
      const body = await res.json<{ members: Array<Record<string, unknown>> }>();
      expect(body.members.map((m) => m.status).sort()).toEqual(["active", "inactive", "pending"]);
      expect(body.members.every((m) => typeof m.paymentRef === "string")).toBe(true);
      expect(JSON.stringify(body)).not.toContain("clerk");
    });

    it("the admin list is admin only", async () => {
      const plain = await makeMember(t.db);
      expect((await call(plain, "GET", "/admin/members")).status).toBe(403);
      expect((await call(null, "GET", "/admin/members")).status).toBe(401);
    });

    it("the member directory lists active members only, without private fields", async () => {
      const me = await makeMember(t.db, { displayName: "Ada Lovelace" });
      await t.db.update(member).set({ rosterName: "Ada L" }).where(eq(member.id, me.id));
      await makeMember(t.db, { status: "inactive" });
      await makeMember(t.db, { status: "pending" });
      const res = await call(me, "GET", "/members");
      expect(res.status).toBe(200);
      const body = await res.json<{ members: Array<Record<string, unknown>> }>();
      expect(body.members).toHaveLength(1);
      expect(body.members[0]).toEqual({
        id: me.id,
        displayName: "Ada Lovelace",
        rosterName: "Ada L",
      });
    });

    it("a pending member cannot see the directory", async () => {
      const pending = await makeMember(t.db, { status: "pending" });
      expect((await call(pending, "GET", "/members")).status).toBe(403);
    });
  });

  describe("roles", () => {
    it("an admin promotes a member, and the change is audited", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      const res = await call(admin, "PATCH", `/members/${target.id}/role`, { role: "admin" });
      expect(res.status).toBe(200);
      expect((await reload(target)).role).toBe("admin");
      const [entry] = await auditFor(target.id);
      expect(entry).toMatchObject({
        actorId: admin.id,
        action: "member.role_change",
        entity: "member",
      });
      expect(JSON.parse(entry!.before!)).toEqual({ role: "member" });
      expect(JSON.parse(entry!.after!)).toEqual({ role: "admin" });
      expect(entry!.at.toISOString()).toBe(NOW);
    });

    it("setting the role a member already has changes and audits nothing", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      const res = await call(admin, "PATCH", `/members/${target.id}/role`, { role: "member" });
      expect(res.status).toBe(200);
      expect(await auditFor(target.id)).toEqual([]);
    });

    it("the last admin can't be demoted, not even by themselves", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const res = await call(admin, "PATCH", `/members/${admin.id}/role`, { role: "member" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "last_admin" });
      expect((await reload(admin)).role).toBe("admin");
      expect(await auditFor(admin.id)).toEqual([]);
    });

    it("an admin can be demoted when another active admin remains", async () => {
      const a = await makeMember(t.db, { role: "admin" });
      const b = await makeMember(t.db, { role: "admin" });
      expect((await call(a, "PATCH", `/members/${b.id}/role`, { role: "member" })).status).toBe(
        200,
      );
      expect((await reload(b)).role).toBe("member");
    });

    it("an inactive admin does not count as the remaining admin", async () => {
      const a = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin", status: "inactive" });
      const res = await call(a, "PATCH", `/members/${a.id}/role`, { role: "member" });
      expect(res.status).toBe(409);
    });

    it("two admins demoting each other at once leaves exactly one admin", async () => {
      const a = await makeMember(t.db, { role: "admin" });
      const b = await makeMember(t.db, { role: "admin" });
      const [r1, r2] = await Promise.all([
        call(a, "PATCH", `/members/${b.id}/role`, { role: "member" }),
        call(b, "PATCH", `/members/${a.id}/role`, { role: "member" }),
      ]);
      // The loser is refused either by the last-admin check (409) or, when the winner's
      // demotion committed before its actor was resolved, by the guard (403).
      const statuses = [r1.status, r2.status].sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      const admins = await t.db.select().from(member).where(eq(member.role, "admin"));
      expect(admins).toHaveLength(1);
    });

    it("non-admins get 403, unknown members 404, bad roles 400", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      expect(
        (await call(plain, "PATCH", `/members/${plain.id}/role`, { role: "admin" })).status,
      ).toBe(403);
      expect((await reload(plain)).role).toBe("member");
      expect((await call(admin, "PATCH", "/members/nope/role", { role: "admin" })).status).toBe(
        404,
      );
      expect(
        (await call(admin, "PATCH", `/members/${plain.id}/role`, { role: "owner" })).status,
      ).toBe(400);
    });
  });

  describe("exit lifecycle: deactivate (PLAN §6.7)", () => {
    it("deactivating records left_at, cancels future RSVPs through the port, and audits", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      const res = await call(admin, "PATCH", `/members/${target.id}/status`, {
        status: "inactive",
      });
      expect(res.status).toBe(200);
      const after = await reload(target);
      expect(after.status).toBe("inactive");
      expect(after.leftAt?.toISOString()).toBe(NOW);
      expect(rsvp.calls).toEqual([
        expect.objectContaining({
          memberId: target.id,
          at: new Date(NOW),
          idempotencyKey: `member-deactivate:${target.id}:${NOW}`,
        }),
      ]);
      const [entry] = await auditFor(target.id);
      expect(entry).toMatchObject({ actorId: admin.id, action: "member.status_change" });
      expect(JSON.parse(entry!.before!)).toMatchObject({ status: "active" });
      expect(JSON.parse(entry!.after!)).toMatchObject({ status: "inactive" });
    });

    it("reactivating clears left_at and cancels nothing", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db, { status: "inactive" });
      await t.db
        .update(member)
        .set({ leftAt: new Date("2027-01-01T00:00:00Z") })
        .where(eq(member.id, target.id));
      const res = await call(admin, "PATCH", `/members/${target.id}/status`, { status: "active" });
      expect(res.status).toBe(200);
      const after = await reload(target);
      expect(after.status).toBe("active");
      expect(after.leftAt).toBeNull();
      expect(rsvp.calls).toEqual([]);
      expect(await auditFor(target.id)).toHaveLength(1);
    });

    it("repeating a deactivate is safe: no second audit row, same cancel key", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      const path = `/members/${target.id}/status`;
      await call(admin, "PATCH", path, { status: "inactive" });
      expect((await call(admin, "PATCH", path, { status: "inactive" })).status).toBe(200);
      expect(await auditFor(target.id)).toHaveLength(1);
      expect(rsvp.calls).toHaveLength(2);
      expect(rsvp.calls[1]!.idempotencyKey).toBe(rsvp.calls[0]!.idempotencyKey);
    });

    it("if the RSVP cancel fails the member stays inactive and a retry completes it", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      rsvp.failNext(new Error("rsvp store down"));
      const path = `/members/${target.id}/status`;
      expect((await call(admin, "PATCH", path, { status: "inactive" })).status).toBe(500);
      expect((await reload(target)).status).toBe("inactive");
      expect((await call(admin, "PATCH", path, { status: "inactive" })).status).toBe(200);
      expect(rsvp.calls).toHaveLength(2);
    });

    it("the last active admin can't be deactivated", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const res = await call(admin, "PATCH", `/members/${admin.id}/status`, { status: "inactive" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "last_admin" });
      expect((await reload(admin)).status).toBe("active");
      expect(rsvp.calls).toEqual([]);
    });

    it("only active and inactive are switched here: pending and erased are refused", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const pending = await makeMember(t.db, { status: "pending" });
      const erased = await makeMember(t.db, { status: "erased" });
      for (const target of [pending, erased]) {
        const res = await call(admin, "PATCH", `/members/${target.id}/status`, {
          status: "active",
        });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: "invalid_transition" });
      }
      expect(
        (await call(admin, "PATCH", `/members/${pending.id}/status`, { status: "erased" })).status,
      ).toBe(400);
    });

    it("is admin only", async () => {
      const plain = await makeMember(t.db);
      const other = await makeMember(t.db);
      const res = await call(plain, "PATCH", `/members/${other.id}/status`, { status: "inactive" });
      expect(res.status).toBe(403);
      expect(rsvp.calls).toEqual([]);
    });

    it("an inactive member gets 403 on events and 200 on their own ledger", async () => {
      const gone = await makeMember(t.db, { status: "inactive" });
      // Stand-in routes with the guards the real areas use: events (S3.0) are plain member
      // routes, the own ledger (S5.1) opts in with allowInactive.
      const app = new Hono<AppEnv>()
        .use("*", contextMiddleware())
        .get("/events", requireGuard("member"), (c) => c.json({ ok: true }))
        .get("/me/ledger", requireGuard("member", { allowInactive: true }), (c) =>
          c.json({ ok: true }),
        );
      const as = { headers: { [TEST_IDENTITY_HEADER]: gone.clerkUserId } };
      expect((await app.request("/events", as, testEnv)).status).toBe(403);
      expect((await app.request("/me/ledger", as, testEnv)).status).toBe(200);
      // Exited members keep access to their payment reference on /me/profile to settle balances (PLAN §6.7).
      expect((await call(gone, "GET", "/me/profile")).status).toBe(200);
      const pending = await makeMember(t.db, { status: "pending" });
      expect((await call(pending, "GET", "/me/profile")).status).toBe(403);
    });

    it("POST /members/:id/approve lets an admin approve a pending member directly and is idempotent", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const pending = await makeMember(t.db, { status: "pending" });
      const inactive = await makeMember(t.db, { status: "inactive" });

      expect((await call(plain, "POST", `/members/${pending.id}/approve`)).status).toBe(403);
      expect((await call(admin, "POST", `/members/${inactive.id}/approve`)).status).toBe(409);

      const res = await call(admin, "POST", `/members/${pending.id}/approve`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ memberId: pending.id, status: "active" });
      const updated = await reload(pending);
      expect(updated.status).toBe("active");
      expect(updated.joinedAt).toBeInstanceOf(Date);

      const again = await call(admin, "POST", `/members/${pending.id}/approve`);
      expect(again.status).toBe(200);
      expect(await auditFor(pending.id)).toHaveLength(1);
    });
  });

  describe("payment_ref", () => {
    it("an admin sets it, normalised to upper case, and the change is audited", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      const res = await call(admin, "PATCH", `/members/${target.id}`, { paymentRef: " bc-ada-7 " });
      expect(res.status).toBe(200);
      expect((await reload(target)).paymentRef).toBe("BC-ADA-7");
      const [entry] = await auditFor(target.id);
      expect(entry).toMatchObject({ action: "member.update", actorId: admin.id });
      expect(JSON.parse(entry!.after!)).toMatchObject({ paymentRef: "BC-ADA-7" });
    });

    it("a taken value (any letter case) is refused with 409", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      await call(admin, "PATCH", `/members/${a.id}`, { paymentRef: "BC-ONE" });
      const res = await call(admin, "PATCH", `/members/${b.id}`, { paymentRef: "bc-one" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "payment_ref_taken" });
      expect(await auditFor(b.id)).toEqual([]);
    });

    it("stays unique when two members claim the same value at once", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      const [r1, r2] = await Promise.all([
        call(admin, "PATCH", `/members/${a.id}`, { paymentRef: "BC-RACE" }),
        call(admin, "PATCH", `/members/${b.id}`, { paymentRef: "BC-RACE" }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const holders = await t.db.select().from(member).where(eq(member.paymentRef, "BC-RACE"));
      expect(holders).toHaveLength(1);
    });

    it("rejects values that are too short, too long or have odd characters", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db);
      for (const paymentRef of ["ab", "x".repeat(41), "bad ref!", ""]) {
        expect((await call(admin, "PATCH", `/members/${target.id}`, { paymentRef })).status).toBe(
          400,
        );
      }
    });

    it("a member cannot change their own payment_ref", async () => {
      const plain = await makeMember(t.db);
      const res = await call(plain, "PATCH", `/members/${plain.id}`, { paymentRef: "BC-MINE" });
      expect(res.status).toBe(403);
      expect((await reload(plain)).paymentRef).toBe(plain.paymentRef);
    });
  });

  describe("profile", () => {
    it("GET /me/profile returns the caller's own profile", async () => {
      const me = await makeMember(t.db, { displayName: "Ada Lovelace" });
      const res = await call(me, "GET", "/me/profile");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: me.id,
        displayName: "Ada Lovelace",
        rosterName: null,
        paymentRef: me.paymentRef,
      });
    });

    it("a member edits their own display and roster name, audited; an empty roster name clears it", async () => {
      const me = await makeMember(t.db);
      const res = await call(me, "PATCH", `/members/${me.id}`, {
        displayName: "  Ada L  ",
        rosterName: "Ada",
      });
      expect(res.status).toBe(200);
      const row = await reload(me);
      expect(row).toMatchObject({ displayName: "Ada L", rosterName: "Ada" });
      expect(await auditFor(me.id)).toHaveLength(1);

      await call(me, "PATCH", `/members/${me.id}`, { rosterName: "" });
      expect((await reload(me)).rosterName).toBeNull();
      expect(await auditFor(me.id)).toHaveLength(2);
    });

    it("a member cannot edit someone else, an admin can", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      expect((await call(a, "PATCH", `/members/${b.id}`, { rosterName: "X" })).status).toBe(403);
      expect((await call(admin, "PATCH", `/members/${b.id}`, { rosterName: "Bea" })).status).toBe(
        200,
      );
      expect((await reload(b)).rosterName).toBe("Bea");
    });

    it("validates names and refuses an empty patch", async () => {
      const me = await makeMember(t.db);
      const path = `/members/${me.id}`;
      expect((await call(me, "PATCH", path, { displayName: "  " })).status).toBe(400);
      expect((await call(me, "PATCH", path, { displayName: "x".repeat(81) })).status).toBe(400);
      expect((await call(me, "PATCH", path, { rosterName: "x".repeat(41) })).status).toBe(400);
      expect((await call(me, "PATCH", path, {})).status).toBe(400);
      expect(await auditFor(me.id)).toEqual([]);
    });

    it("a patch that changes nothing is not audited", async () => {
      const me = await makeMember(t.db, { displayName: "Same" });
      expect((await call(me, "PATCH", `/members/${me.id}`, { displayName: "Same" })).status).toBe(
        200,
      );
      expect(await auditFor(me.id)).toEqual([]);
    });
  });
});
