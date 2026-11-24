import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { auditLog, ledgerEntry, notification, paymentClaim } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import claimsRoutes from "./claims";
import routes from "./routes";
import { createLedgerService } from "./service";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

interface ClaimBody {
  id: string;
  memberId: string;
  amountSek: number;
  paidOn: string;
  note: string | null;
  status: "pending" | "confirmed" | "rejected";
  rejectReason: string | null;
}

interface AdminClaimBody extends ClaimBody {
  displayName: string;
  paymentRef: string;
  balanceSek: number;
  isOwn: boolean;
}

describe("payment claims", () => {
  let t: TestDatabase;
  let clock: FixedClock;

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock("2027-03-01T10:00:00Z");
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const headers = (clerkUserId: string | undefined, key?: string) => ({
    "Content-Type": "application/json",
    ...(clerkUserId === undefined ? {} : { [TEST_IDENTITY_HEADER]: clerkUserId }),
    ...(key === undefined ? {} : { "Idempotency-Key": key }),
  });

  const get = async (path: string, clerkUserId?: string): Promise<Response> =>
    claimsRoutes.request(path, { headers: headers(clerkUserId) }, testEnv);

  const post = async (
    path: string,
    body: unknown,
    clerkUserId?: string,
    key?: string,
  ): Promise<Response> =>
    claimsRoutes.request(
      path,
      { method: "POST", headers: headers(clerkUserId, key), body: JSON.stringify(body) },
      testEnv,
    );

  const myClaims = async (clerkUserId: string) =>
    (await get("/me/payment-claims", clerkUserId)).json<{ claims: ClaimBody[] }>();

  const ledgerRows = (memberId: string) =>
    t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, memberId));

  async function owing(memberId: string, amountSek: number) {
    await createLedgerService({ db: t.db, clock }).charge({
      memberId,
      amountSek,
      reason: "adhoc",
      idempotencyKey: `charge-${memberId}`,
    });
  }

  async function claim(clerkUserId: string, amountSek = 500, key = crypto.randomUUID()) {
    const res = await post(
      "/me/payment-claims",
      { amountSek, paidOn: "2027-02-27", note: "Swish" },
      clerkUserId,
      key,
    );
    expect(res.status).toBe(201);
    return res.json<ClaimBody>();
  }

  describe("member claims", () => {
    it("a pending claim doesn't change the balance", async () => {
      const m = await makeMember(t.db);
      await owing(m.id, 500);
      const created = await claim(m.clerkUserId);

      expect(created).toMatchObject({
        memberId: m.id,
        amountSek: 500,
        paidOn: "2027-02-27",
        note: "Swish",
        status: "pending",
      });
      expect(await createLedgerService({ db: t.db, clock }).balance(m.id)).toBe(500);
      expect(await ledgerRows(m.id)).toHaveLength(1);

      const mine = await myClaims(m.clerkUserId);
      expect(mine.claims.map((c) => c.id)).toEqual([created.id]);
    });

    it("a double-tapped claim creates one claim", async () => {
      const m = await makeMember(t.db);
      const [a, b] = await Promise.all([
        post("/me/payment-claims", { amountSek: 100, paidOn: "2027-02-27" }, m.clerkUserId, "k"),
        post("/me/payment-claims", { amountSek: 100, paidOn: "2027-02-27" }, m.clerkUserId, "k"),
      ]);
      expect([a.status, b.status].sort()).toContain(201);
      expect(await t.db.select().from(paymentClaim)).toHaveLength(1);
    });

    it("needs an Idempotency-Key, whole kronor above 0 and a paid-on date not in the future", async () => {
      const m = await makeMember(t.db);
      const at = (body: unknown, key: string | undefined = crypto.randomUUID()) =>
        post("/me/payment-claims", body, m.clerkUserId, key).then((r) => r.status);

      // at(…, undefined) would fall back to the default key, so post without one directly.
      const noKey = await post(
        "/me/payment-claims",
        { amountSek: 100, paidOn: "2027-02-27" },
        m.clerkUserId,
      );
      expect(noKey.status).toBe(400);
      expect(await at({ amountSek: 0, paidOn: "2027-02-27" })).toBe(400);
      expect(await at({ amountSek: 12.5, paidOn: "2027-02-27" })).toBe(400);
      expect(await at({ amountSek: "100", paidOn: "2027-02-27" })).toBe(400);
      expect(await at({ amountSek: 100, paidOn: "27/02/2027" })).toBe(400);
      expect(await at({ amountSek: 100, paidOn: "2027-02-30" })).toBe(400);
      expect(await at({ amountSek: 100, paidOn: "2027-03-02" })).toBe(400);
      expect(await at({ amountSek: 100, paidOn: "2027-03-01" })).toBe(201);
      expect(await t.db.select().from(paymentClaim)).toHaveLength(1);
    });

    it("lets an exited member claim; refuses anonymous and pending callers", async () => {
      const exited = await makeMember(t.db, { status: "inactive" });
      const pending = await makeMember(t.db, { status: "pending" });
      await claim(exited.clerkUserId);
      expect((await get("/me/payment-claims")).status).toBe(401);
      expect(
        (
          await post(
            "/me/payment-claims",
            { amountSek: 1, paidOn: "2027-02-27" },
            pending.clerkUserId,
            "x",
          )
        ).status,
      ).toBe(403);
    });

    it("members only see their own claims", async () => {
      const a = await makeMember(t.db);
      const b = await makeMember(t.db);
      await claim(a.clerkUserId);
      const seen = await myClaims(b.clerkUserId);
      expect(seen.claims).toEqual([]);
    });
  });

  describe("admin queue", () => {
    it("lists pending claims with member, balance and isOwn; members get 403", async () => {
      const admin = await makeMember(t.db, { role: "admin", displayName: "Ada" });
      await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db, { displayName: "Bo" });
      await owing(m.id, 300);
      const mine = await claim(admin.clerkUserId, 50);
      const theirs = await claim(m.clerkUserId, 300);

      expect((await get("/admin/payment-claims", m.clerkUserId)).status).toBe(403);
      const res = await get("/admin/payment-claims", admin.clerkUserId);
      expect(res.status).toBe(200);
      const { claims } = await res.json<{ claims: AdminClaimBody[] }>();
      const byId = new Map(claims.map((c) => [c.id, c]));
      expect(byId.get(theirs.id)).toMatchObject({
        displayName: "Bo",
        balanceSek: 300,
        isOwn: false,
      });
      expect(byId.get(mine.id)).toMatchObject({ isOwn: true });
    });
  });

  describe("confirm", () => {
    it("creates exactly one linked payment, even when double-tapped", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const admin2 = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await owing(m.id, 500);
      const c = await claim(m.clerkUserId, 500);
      const path = `/admin/payment-claims/${c.id}/confirm`;

      // Same key twice at once, plus a second key and a second admin: one payment.
      const results = await Promise.all([
        post(path, {}, admin.clerkUserId, "tap"),
        post(path, {}, admin.clerkUserId, "tap"),
        post(path, {}, admin.clerkUserId, "tap-2"),
        post(path, {}, admin2.clerkUserId, "other"),
      ]);
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      for (const r of results) expect([200, 409]).toContain(r.status);

      const payments = (await ledgerRows(m.id)).filter((r) => r.kind === "payment");
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        amountSek: -500,
        paymentClaimId: c.id,
        idempotencyKey: `claim:${c.id}`,
      });
      expect(await createLedgerService({ db: t.db, clock }).balance(m.id)).toBe(0);

      const [row] = await t.db.select().from(paymentClaim).where(eq(paymentClaim.id, c.id));
      expect(row?.status).toBe("confirmed");
      expect([admin.id, admin2.id]).toContain(row?.decidedBy);
      expect(row?.decidedAt?.toISOString()).toBe("2027-03-01T10:00:00.000Z");

      // A later confirm answers with the same payment and writes nothing.
      const again = await post(path, {}, admin2.clerkUserId, "later");
      expect(again.status).toBe(200);
      expect((await again.json<{ entryId: string }>()).entryId).toBe(payments[0]?.id);
      expect((await ledgerRows(m.id)).filter((r) => r.kind === "payment")).toHaveLength(1);

      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, c.id));
      expect(audits.map((a) => a.action)).toEqual(["payment_claim.confirm"]);
      const notes = await t.db.select().from(notification).where(eq(notification.memberId, m.id));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.category).toBe("payment_status");
    });

    it("an admin can't confirm their own claim, even as the only admin", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const c = await claim(admin.clerkUserId, 200);
      const res = await post(`/admin/payment-claims/${c.id}/confirm`, {}, admin.clerkUserId, "k");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "own_claim" });
      expect(await ledgerRows(admin.id)).toHaveLength(0);
      const [row] = await t.db.select().from(paymentClaim).where(eq(paymentClaim.id, c.id));
      expect(row?.status).toBe("pending");
    });

    it("refuses members, unknown claims and rejected claims", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const c = await claim(m.clerkUserId, 100);
      expect(
        (await post(`/admin/payment-claims/${c.id}/confirm`, {}, m.clerkUserId, "a")).status,
      ).toBe(403);
      expect(
        (await post("/admin/payment-claims/nope/confirm", {}, admin.clerkUserId, "b")).status,
      ).toBe(404);
      await post(
        `/admin/payment-claims/${c.id}/reject`,
        { reason: "Not received" },
        admin.clerkUserId,
        "c",
      );
      const res = await post(`/admin/payment-claims/${c.id}/confirm`, {}, admin.clerkUserId, "d");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "claim_decided" });
      expect(await ledgerRows(m.id)).toHaveLength(0);
    });
  });

  describe("reject", () => {
    it("rejecting notifies the member with the reason and writes no money", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      await owing(m.id, 500);
      const c = await claim(m.clerkUserId, 500);

      const res = await post(
        `/admin/payment-claims/${c.id}/reject`,
        { reason: "  No transfer with your reference  " },
        admin.clerkUserId,
        "r1",
      );
      expect(res.status).toBe(200);

      const [row] = await t.db.select().from(paymentClaim).where(eq(paymentClaim.id, c.id));
      expect(row).toMatchObject({
        status: "rejected",
        rejectReason: "No transfer with your reference",
        decidedBy: admin.id,
      });
      expect(await createLedgerService({ db: t.db, clock }).balance(m.id)).toBe(500);

      const notes = await t.db.select().from(notification).where(eq(notification.memberId, m.id));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.category).toBe("payment_status");
      expect(notes[0]?.body).toContain("No transfer with your reference");
      expect(notes[0]?.link).toBe("/money/claims");

      const mine = await myClaims(m.clerkUserId);
      expect(mine.claims[0]).toMatchObject({
        status: "rejected",
        rejectReason: "No transfer with your reference",
      });

      // A second reject (another key) changes nothing and notifies once.
      const again = await post(
        `/admin/payment-claims/${c.id}/reject`,
        { reason: "x" },
        admin.clerkUserId,
        "r2",
      );
      expect(again.status).toBe(200);
      expect(
        await t.db.select().from(notification).where(eq(notification.memberId, m.id)),
      ).toHaveLength(1);
      const [still] = await t.db.select().from(paymentClaim).where(eq(paymentClaim.id, c.id));
      expect(still?.rejectReason).toBe("No transfer with your reference");
    });

    it("needs a reason, refuses own claims and confirmed claims", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const c = await claim(m.clerkUserId, 100);
      const own = await claim(admin.clerkUserId, 100);

      expect(
        (await post(`/admin/payment-claims/${c.id}/reject`, {}, admin.clerkUserId, "a")).status,
      ).toBe(400);
      expect(
        (
          await post(
            `/admin/payment-claims/${c.id}/reject`,
            { reason: "  " },
            admin.clerkUserId,
            "b",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await post(
            `/admin/payment-claims/${own.id}/reject`,
            { reason: "x" },
            admin.clerkUserId,
            "c",
          )
        ).status,
      ).toBe(403);

      expect(
        (await post(`/admin/payment-claims/${c.id}/confirm`, {}, admin.clerkUserId, "d")).status,
      ).toBe(200);
      const res = await post(
        `/admin/payment-claims/${c.id}/reject`,
        { reason: "x" },
        admin.clerkUserId,
        "e",
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "claim_decided" });
    });
  });

  it("the ledger area mounts the claim routes", async () => {
    expect((await routes.request("/me/payment-claims", {}, testEnv)).status).toBe(401);
    expect((await routes.request("/admin/payment-claims", {}, testEnv)).status).toBe(401);
  });
});
