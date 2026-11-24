import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { auditLog } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const NOW = "2027-03-01T09:00:00.000Z";

type Row = Awaited<ReturnType<typeof makeMember>>;
interface Entry {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
}
interface Page {
  entries: Entry[];
  nextCursor: string | null;
}

describe("audit-log viewer (S2.4)", () => {
  let t: TestDatabase;
  let admin: Row;
  let seq = 0;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock: new FixedClock(NOW) });
    admin = await makeMember(t.db, { role: "admin", displayName: "Ada Admin" });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  function call(as: Row | null, path: string) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    return routes.request(path, { headers }, testEnv);
  }

  async function page(path: string): Promise<Page> {
    const res = await call(admin, path);
    expect(res.status).toBe(200);
    return res.json<Page>();
  }

  async function row(
    at: string,
    over: Partial<{
      id: string;
      actorId: string | null;
      action: string;
      entity: string;
      entityId: string;
    }> = {},
  ) {
    const id = over.id ?? `aud_${String(++seq).padStart(3, "0")}`;
    await t.db.insert(auditLog).values({
      id,
      actorId: over.actorId === undefined ? admin.id : over.actorId,
      action: over.action ?? "member.update",
      entity: over.entity ?? "member",
      entityId: over.entityId ?? "mem_x",
      before: JSON.stringify({ displayName: "Old" }),
      after: JSON.stringify({ displayName: "New" }),
      at: new Date(at),
    });
    return id;
  }

  describe("access", () => {
    it("members get 403, anonymous 401, pending and inactive admins 403", async () => {
      const plain = await makeMember(t.db);
      const pending = await makeMember(t.db, { role: "admin", status: "pending" });
      const gone = await makeMember(t.db, { role: "admin", status: "inactive" });
      expect((await call(plain, "/admin/audit")).status).toBe(403);
      expect((await call(pending, "/admin/audit")).status).toBe(403);
      expect((await call(gone, "/admin/audit")).status).toBe(403);
      expect((await call(null, "/admin/audit")).status).toBe(401);
    });

    it("an admin sees entries newest first with actor name and parsed before/after", async () => {
      await row("2027-02-01T10:00:00Z", { id: "aud_old" });
      await row("2027-02-02T10:00:00Z", { id: "aud_new", actorId: null });
      const body = await page("/admin/audit");
      expect(body.entries.map((e) => e.id)).toEqual(["aud_new", "aud_old"]);
      expect(body.entries[1]).toMatchObject({
        actorId: admin.id,
        actorName: "Ada Admin",
        action: "member.update",
        entity: "member",
        entityId: "mem_x",
        before: { displayName: "Old" },
        after: { displayName: "New" },
        at: "2027-02-01T10:00:00.000Z",
      });
      expect(body.entries[0]).toMatchObject({ actorId: null, actorName: null });
      expect(body.nextCursor).toBeNull();
    });
  });

  describe("filters", () => {
    it("filter by actor, entity, entityId and action (exact match, combined with AND)", async () => {
      const other = await makeMember(t.db, { role: "admin" });
      await row("2027-02-01T10:00:00Z", { id: "a1", action: "member.role_change" });
      await row("2027-02-01T11:00:00Z", { id: "a2", actorId: other.id });
      await row("2027-02-01T12:00:00Z", {
        id: "a3",
        entity: "event",
        entityId: "evt_1",
        action: "event.create",
      });
      await row("2027-02-01T13:00:00Z", {
        id: "a4",
        entity: "event",
        entityId: "evt_2",
        action: "event.create",
      });

      const ids = async (q: string) => (await page(`/admin/audit?${q}`)).entries.map((e) => e.id);
      expect(await ids(`actor=${other.id}`)).toEqual(["a2"]);
      expect(await ids("entity=event")).toEqual(["a4", "a3"]);
      expect(await ids("entity=event&entityId=evt_1")).toEqual(["a3"]);
      expect(await ids("action=member.role_change")).toEqual(["a1"]);
      expect(await ids(`action=event.create&actor=${other.id}`)).toEqual([]);
      expect(await ids("action=member")).toEqual([]);
    });

    it("date range: from is inclusive, to is exclusive", async () => {
      await row("2027-02-01T00:00:00Z", { id: "d1" });
      await row("2027-02-02T00:00:00Z", { id: "d2" });
      await row("2027-02-03T00:00:00Z", { id: "d3" });
      const ids = async (q: string) => (await page(`/admin/audit?${q}`)).entries.map((e) => e.id);
      expect(await ids("from=2027-02-02T00:00:00Z")).toEqual(["d3", "d2"]);
      expect(await ids("to=2027-02-02T00:00:00Z")).toEqual(["d1"]);
      expect(await ids("from=2027-02-01T00:00:00Z&to=2027-02-03T00:00:00Z")).toEqual(["d2", "d1"]);
    });

    it("rejects malformed parameters with 400", async () => {
      expect((await call(admin, "/admin/audit?from=yesterday")).status).toBe(400);
      expect((await call(admin, "/admin/audit?to=2027-13-45")).status).toBe(400);
      expect((await call(admin, "/admin/audit?limit=0")).status).toBe(400);
      expect((await call(admin, "/admin/audit?limit=101")).status).toBe(400);
      expect((await call(admin, "/admin/audit?limit=abc")).status).toBe(400);
      expect((await call(admin, "/admin/audit?cursor=not-a-cursor")).status).toBe(400);
    });
  });

  describe("pagination", () => {
    it("walks every row exactly once, tie-breaking equal timestamps on id", async () => {
      // Five rows share one instant: only the id keeps their order stable.
      for (const id of ["t1", "t2", "t3", "t4", "t5"]) await row("2027-02-01T10:00:00Z", { id });
      await row("2027-02-01T09:00:00Z", { id: "t0" });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: Page = await page(`/admin/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(body.entries.length).toBeLessThanOrEqual(2);
        seen.push(...body.entries.map((e) => e.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["t5", "t4", "t3", "t2", "t1", "t0"]);
    });

    it("is stable when rows are inserted between pages", async () => {
      for (let i = 0; i < 5; i++)
        await row(`2027-02-01T10:0${String(i)}:00Z`, { id: `p${String(i)}` });
      const first = await page("/admin/audit?limit=2");
      expect(first.entries.map((e) => e.id)).toEqual(["p4", "p3"]);

      // New activity lands while the admin reads page 1 (newer than everything).
      await row("2027-02-01T11:00:00Z", { id: "p_new1" });
      await row("2027-02-01T11:00:01Z", { id: "p_new2" });

      const second = await page(`/admin/audit?limit=2&cursor=${String(first.nextCursor)}`);
      expect(second.entries.map((e) => e.id)).toEqual(["p2", "p1"]);
      const third = await page(`/admin/audit?limit=2&cursor=${String(second.nextCursor)}`);
      expect(third.entries.map((e) => e.id)).toEqual(["p0"]);
      expect(third.nextCursor).toBeNull();
    });

    it("keeps sub-millisecond timestamps apart (database default now())", async () => {
      // Rows written with now() carry microseconds; a millisecond cursor would skip or repeat.
      await t.db.execute(sql`
        INSERT INTO audit_log (id, actor_id, action, entity, entity_id, at) VALUES
          ('u1', NULL, 'x', 'e', '1', '2027-02-01T10:00:00.000100Z'),
          ('u2', NULL, 'x', 'e', '1', '2027-02-01T10:00:00.000200Z'),
          ('u0', NULL, 'x', 'e', '1', '2027-02-01T10:00:00.000300Z')`);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: Page = await page(`/admin/audit?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...body.entries.map((e) => e.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["u0", "u2", "u1"]);
    });

    it("filters apply on every page", async () => {
      for (let i = 0; i < 4; i++) {
        await row(`2027-02-01T10:0${String(i)}:00Z`, { id: `f${String(i)}`, entity: "event" });
        await row(`2027-02-01T10:0${String(i)}:30Z`, { id: `g${String(i)}`, entity: "member" });
      }
      const one = await page("/admin/audit?entity=event&limit=3");
      const two = await page(`/admin/audit?entity=event&limit=3&cursor=${String(one.nextCursor)}`);
      expect([...one.entries, ...two.entries].map((e) => e.id)).toEqual(["f3", "f2", "f1", "f0"]);
      expect(two.nextCursor).toBeNull();
    });
  });
});
