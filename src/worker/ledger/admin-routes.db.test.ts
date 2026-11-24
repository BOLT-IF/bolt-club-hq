import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { auditLog, ledgerEntry } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import adminRoutes from "./admin-routes";
import routes from "./routes";
import { createLedgerService } from "./service";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

interface BalancesBody {
  members: Array<{
    id: string;
    displayName: string;
    paymentRef: string;
    status: string;
    balanceSek: number;
    owedSek: number;
    creditSek: number;
  }>;
}

interface DetailBody {
  member: { id: string; displayName: string; paymentRef: string; status: string };
  balanceSek: number;
  owedSek: number;
  creditSek: number;
  items: Array<{
    id: string;
    kind: string;
    reason: string;
    amountSek: number;
    status: string;
    allocatedSek: number;
    outstandingSek: number;
    note: string;
    reversesEntryId: string | null;
    waivable: boolean;
    reversible: boolean;
  }>;
}

interface WriteBody {
  entryId: string;
  balanceSek: number;
}

describe("admin money routes", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-02-01T10:00:00Z");
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const as = (clerkUserId: string | undefined, extra: Record<string, string> = {}) =>
    clerkUserId === undefined ? extra : { [TEST_IDENTITY_HEADER]: clerkUserId, ...extra };

  const get = (path: string, clerkUserId?: string) =>
    adminRoutes.request(path, { headers: as(clerkUserId) }, testEnv);

  const post = (path: string, body: unknown, clerkUserId?: string, key?: string) =>
    adminRoutes.request(
      path,
      {
        method: "POST",
        headers: as(clerkUserId, {
          "Content-Type": "application/json",
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        }),
        body: JSON.stringify(body),
      },
      testEnv,
    );

  async function entriesOf(memberId: string) {
    return t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, memberId));
  }

  async function charge(memberId: string, amountSek: number, key: string) {
    await createLedgerService({ db: t.db, clock }).charge({
      memberId,
      amountSek,
      reason: "adhoc",
      idempotencyKey: key,
    });
    clock.advance(1000);
  }

  describe("permissions", () => {
    it("members get 403 on every admin money route, anonymous callers 401", async () => {
      const m = await makeMember(t.db);
      const other = await makeMember(t.db);
      await charge(other.id, 100, "c1");
      const [entry] = await entriesOf(other.id);

      expect((await get("/admin/balances")).status).toBe(401);
      expect((await get("/admin/balances", m.clerkUserId)).status).toBe(403);
      expect((await get(`/admin/balances/${other.id}`, m.clerkUserId)).status).toBe(403);
      expect(
        (await post("/admin/payments", { memberId: other.id, amountSek: 100 }, m.clerkUserId, "k1"))
          .status,
      ).toBe(403);
      expect(
        (
          await post(
            "/admin/adjustments",
            { type: "waiver", entryId: entry?.id, note: "x" },
            m.clerkUserId,
            "k2",
          )
        ).status,
      ).toBe(403);
      // Nothing was written by the refused calls.
      expect(await entriesOf(other.id)).toHaveLength(1);
    });

    it("an inactive admin is refused", async () => {
      const exAdmin = await makeMember(t.db, { role: "admin", status: "inactive" });
      expect((await get("/admin/balances", exAdmin.clerkUserId)).status).toBe(403);
    });

    it("the ledger area mounts the admin routes", async () => {
      const res = await routes.request("/admin/balances", {}, testEnv);
      expect(res.status).toBe(401);
    });
  });

  describe("payments", () => {
    it("a payment updates the balance and the FIFO allocation", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db, { displayName: "Bo Berg" });
      await charge(m.id, 120, "c1");
      await charge(m.id, 120, "c2");

      const res = await post(
        "/admin/payments",
        { memberId: m.id, amountSek: 150, note: "Swish" },
        admin.clerkUserId,
        "pay-1",
      );
      expect(res.status).toBe(201);
      expect(await res.json<WriteBody>()).toMatchObject({ balanceSek: 90 });

      const list = await (await get("/admin/balances", admin.clerkUserId)).json<BalancesBody>();
      expect(list.members.find((row) => row.id === m.id)).toMatchObject({
        displayName: "Bo Berg",
        balanceSek: 90,
        owedSek: 90,
        creditSek: 0,
      });

      const detail = await (
        await get(`/admin/balances/${m.id}`, admin.clerkUserId)
      ).json<DetailBody>();
      expect(detail).toMatchObject({ balanceSek: 90, owedSek: 90, creditSek: 0 });
      expect(detail.member).toMatchObject({ id: m.id, displayName: "Bo Berg" });
      expect(detail.items.map((i) => [i.kind, i.status, i.allocatedSek, i.outstandingSek])).toEqual(
        [
          ["charge", "paid", 120, 0],
          ["charge", "partly_paid", 30, 90],
          ["payment", "applied", 150, 0],
        ],
      );
      expect(detail.items[2]).toMatchObject({ amountSek: -150, note: "Swish", waivable: false });
    });

    it("a double-tapped payment is recorded once", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const body = { memberId: m.id, amountSek: 200 };

      const taps = await Promise.all([
        post("/admin/payments", body, admin.clerkUserId, "tap"),
        post("/admin/payments", body, admin.clerkUserId, "tap"),
      ]);
      expect(taps.some((r) => r.status === 201)).toBe(true);
      expect(taps.every((r) => r.status === 201 || r.status === 409)).toBe(true);

      const retry = await post("/admin/payments", body, admin.clerkUserId, "tap");
      expect(retry.status).toBe(201);

      const rows = await entriesOf(m.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amountSek).toBe(-200);
      const audits = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "ledger.payment"));
      expect(audits).toHaveLength(1);
    });

    it("needs an Idempotency-Key", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const res = await post("/admin/payments", { memberId: m.id, amountSek: 10 }, admin.clerkUserId);
      expect(res.status).toBe(400);
      expect(await entriesOf(m.id)).toHaveLength(0);
    });

    it("refuses fractional, zero, negative and string amounts with 400, unknown member with 404", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      for (const [i, amountSek] of [12.5, 0, -10, "100"].entries()) {
        const res = await post(
          "/admin/payments",
          { memberId: m.id, amountSek },
          admin.clerkUserId,
          `bad-${String(i)}`,
        );
        expect(res.status, String(amountSek)).toBe(400);
      }
      const missing = await post(
        "/admin/payments",
        { memberId: "nobody", amountSek: 10 },
        admin.clerkUserId,
        "missing",
      );
      expect(missing.status).toBe(404);
      expect(await entriesOf(m.id)).toHaveLength(0);
    });

    it("an exited (inactive) member's payment can still be recorded", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const gone = await makeMember(t.db, { status: "inactive" });
      await charge(gone.id, 300, "c1");
      const res = await post(
        "/admin/payments",
        { memberId: gone.id, amountSek: 300 },
        admin.clerkUserId,
        "p",
      );
      expect(res.status).toBe(201);
      expect(await res.json<WriteBody>()).toMatchObject({ balanceSek: 0 });
    });
  });

  describe("adjustments", () => {
    it("a waiver creates a reversal and an audit entry", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await charge(m.id, 120, "c1");
      const [original] = await entriesOf(m.id);
      if (!original) throw new Error("no charge");

      const res = await post(
        "/admin/adjustments",
        { type: "waiver", entryId: original.id, note: "Injured, agreed by board" },
        admin.clerkUserId,
        "w1",
      );
      expect(res.status).toBe(201);
      const written = await res.json<WriteBody>();
      expect(written.balanceSek).toBe(0);

      const rows = await entriesOf(m.id);
      const reversal = rows.find((r) => r.id === written.entryId);
      expect(reversal).toMatchObject({
        kind: "reversal",
        reason: "waiver",
        amountSek: -120,
        reversesEntryId: original.id,
        note: "Injured, agreed by board",
        createdBy: admin.id,
      });

      const audits = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, written.entryId));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: admin.id, action: "ledger.reverse" });
      expect(JSON.parse(audits[0]?.after ?? "{}")).toMatchObject({
        reason: "waiver",
        amountSek: -120,
        reversesEntryId: original.id,
      });

      const detail = await (
        await get(`/admin/balances/${m.id}`, admin.clerkUserId)
      ).json<DetailBody>();
      expect(detail.items.map((i) => [i.status, i.waivable, i.reversible])).toEqual([
        ["reversed", false, false],
        ["reversal", false, false],
      ]);
    });

    it("a waiver needs a note, and a second waiver of the same charge is 409", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await charge(m.id, 120, "c1");
      const [original] = await entriesOf(m.id);

      const noNote = await post(
        "/admin/adjustments",
        { type: "waiver", entryId: original?.id, note: "  " },
        admin.clerkUserId,
        "w0",
      );
      expect(noNote.status).toBe(400);
      expect(await noNote.json()).toMatchObject({ error: "note_required" });

      expect(
        (
          await post(
            "/admin/adjustments",
            { type: "waiver", entryId: original?.id, note: "ok" },
            admin.clerkUserId,
            "w1",
          )
        ).status,
      ).toBe(201);
      const again = await post(
        "/admin/adjustments",
        { type: "waiver", entryId: original?.id, note: "ok" },
        admin.clerkUserId,
        "w2",
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: "already_reversed" });
    });

    it("a payment can't be waived (409), only reversed", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await post("/admin/payments", { memberId: m.id, amountSek: 50 }, admin.clerkUserId, "p");
      const [payment] = await entriesOf(m.id);

      const waive = await post(
        "/admin/adjustments",
        { type: "waiver", entryId: payment?.id, note: "x" },
        admin.clerkUserId,
        "w",
      );
      expect(waive.status).toBe(409);
      expect(await waive.json()).toMatchObject({ error: "not_waivable" });

      const reverse = await post(
        "/admin/adjustments",
        { type: "reversal", entryId: payment?.id, note: "Recorded on the wrong member" },
        admin.clerkUserId,
        "r",
      );
      expect(reverse.status).toBe(201);
      expect(await reverse.json<WriteBody>()).toMatchObject({ balanceSek: 0 });
    });

    it("a partial waiver by amount and a manual charge are adjustments with a note", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await charge(m.id, 120, "c1");

      const waive = await post(
        "/admin/adjustments",
        { type: "waiver", memberId: m.id, amountSek: 20, note: "Late start" },
        admin.clerkUserId,
        "w",
      );
      expect(waive.status).toBe(201);
      expect(await waive.json<WriteBody>()).toMatchObject({ balanceSek: 100 });

      const manual = await post(
        "/admin/adjustments",
        { type: "charge", memberId: m.id, amountSek: 60, note: "Shuttlecocks" },
        admin.clerkUserId,
        "c",
      );
      expect(manual.status).toBe(201);
      expect(await manual.json<WriteBody>()).toMatchObject({ balanceSek: 160 });

      const noNote = await post(
        "/admin/adjustments",
        { type: "charge", memberId: m.id, amountSek: 60, note: "" },
        admin.clerkUserId,
        "c2",
      );
      expect(noNote.status).toBe(400);

      const rows = await entriesOf(m.id);
      expect(rows.map((r) => [r.kind, r.reason, r.amountSek]).sort()).toEqual(
        [
          ["adjustment", "waiver", -20],
          ["charge", "adhoc", 120],
          ["charge", "manual", 60],
        ].sort(),
      );
    });

    it("rejects an unknown adjustment type with 400", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const res = await post(
        "/admin/adjustments",
        { type: "refund", memberId: m.id, amountSek: 10, note: "x" },
        admin.clerkUserId,
        "x",
      );
      expect(res.status).toBe(400);
    });
  });

  describe("self-ledger guard (A11)", () => {
    it("blocks an admin on their own ledger while another active admin exists", async () => {
      const a = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin" });
      await charge(a.id, 120, "c1");
      const [own] = await entriesOf(a.id);

      const pay = await post(
        "/admin/payments",
        { memberId: a.id, amountSek: 120 },
        a.clerkUserId,
        "p",
      );
      expect(pay.status).toBe(403);
      expect(await pay.json()).toMatchObject({ error: "self_ledger_blocked" });

      const waive = await post(
        "/admin/adjustments",
        { type: "waiver", entryId: own?.id, note: "mine" },
        a.clerkUserId,
        "w",
      );
      expect(waive.status).toBe(403);
      expect(await waive.json()).toMatchObject({ error: "self_ledger_blocked" });

      expect(await entriesOf(a.id)).toHaveLength(1);
    });

    it("lets the only admin write on their own ledger, flagged in the audit row", async () => {
      const solo = await makeMember(t.db, { role: "admin" });
      // An inactive admin does not count as another admin.
      await makeMember(t.db, { role: "admin", status: "inactive" });

      const res = await post(
        "/admin/payments",
        { memberId: solo.id, amountSek: 80 },
        solo.clerkUserId,
        "p",
      );
      expect(res.status).toBe(201);
      const { entryId } = await res.json<WriteBody>();
      const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, entryId));
      expect(JSON.parse(row?.after ?? "{}")).toMatchObject({ selfLedgerFlagged: true });
    });
  });
});
