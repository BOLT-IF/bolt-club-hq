/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- response bodies are asserted field by field. */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, clubFee, clubSettings, ledgerEntry, term } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import ledgerRoutes from "./routes";
import { ensureClubFeeForMember } from "./club-fees";
import { createLedgerService } from "./service";

const NOW = "2026-09-15T10:00:00Z"; // Fall 2026 -> clubYear 2026
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

type Member = Awaited<ReturnType<typeof makeMember>>;

describe("admin club fees routes", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  let admin: Member;
  let keySeq = 0;

  const app = () => new Hono<AppEnv>().route("/", ledgerRoutes);

  async function call(
    as: Member | null,
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; key?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    if (method === "POST" && opts.key !== null) {
      headers["Idempotency-Key"] = opts.key ?? `cfk_${String(++keySeq)}`;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await app().request(path, init, testEnv);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = text ? JSON.parse(text) : null;
    return { status: res.status, headers: res.headers, body };
  }

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    admin = await makeMember(t.db, { role: "admin", displayName: "Admin A" });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  it("enforces admin guard and Idempotency-Key", async () => {
    const plain = await makeMember(t.db, { displayName: "Plain" });

    expect((await call(null, "GET", "/admin/club-fees")).status).toBe(401);
    expect((await call(plain, "GET", "/admin/club-fees")).status).toBe(403);
    expect(
      (
        await call(plain, "POST", "/admin/club-fees/charge", {
          body: { clubYear: 2026, season: "fall" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(admin, "POST", "/admin/club-fees/charge", {
          body: { clubYear: 2026, season: "fall" },
          key: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(admin, "POST", "/admin/club-fees/mark-external-fall", {
          body: { clubYear: 2026, memberIds: [plain.id] },
          key: null,
        })
      ).status,
    ).toBe(400);
  });

  it("lists all non-erased members with FIFO-resolved statuses, availableYears, and summary", async () => {
    const mPaidFall = await makeMember(t.db, { displayName: "Alice PaidFall" });
    const mExtFall = await makeMember(t.db, { displayName: "Bob ExtFall" });
    const mUnpaidFall = await makeMember(t.db, { displayName: "Cara UnpaidFall" });
    const mPaidSpring = await makeMember(t.db, { displayName: "Dan PaidSpring" });
    const mUnpaidSpring = await makeMember(t.db, { displayName: "Eve UnpaidSpring" });
    const mExempt = await makeMember(t.db, { displayName: "Fay Exempt" });
    const mNotCharged = await makeMember(t.db, { displayName: "Gus NotCharged" });
    await makeMember(t.db, { displayName: "Erased User", status: "erased" });

    await t.db.insert(term).values({
      id: "term_2025",
      name: "Fall 2025",
      startsOn: "2025-09-01",
      endsOn: "2025-12-15",
      season: "fall",
      clubYear: 2025,
      status: "closed",
    });

    await t.db.insert(clubSettings).values({
      id: 1,
      clubName: "BOLT IF",
      clubFeeFallSek: 180,
      clubFeeSpringSek: 90,
    });

    const ledger = createLedgerService({ db: t.db, clock });

    // 1. Alice paid Fall in-app (FIFO)
    await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [mPaidFall.id] },
    });
    await ledger.recordPayment({
      memberId: mPaidFall.id,
      amountSek: 180,
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "pay-alice",
    });

    // 2. Bob external fall paid
    await call(admin, "POST", "/admin/club-fees/mark-external-fall", {
      body: { clubYear: 2026, memberIds: [mExtFall.id], note: "Swish to old account" },
    });

    // 3. Cara unpaid Fall (partly paid 60 -> owes 120)
    await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [mUnpaidFall.id] },
    });
    await ledger.recordPayment({
      memberId: mUnpaidFall.id,
      amountSek: 60,
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "pay-cara",
    });

    // 4. Dan paid Spring
    await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring", memberIds: [mPaidSpring.id] },
    });
    await ledger.recordPayment({
      memberId: mPaidSpring.id,
      amountSek: 90,
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "pay-dan",
    });

    // 5. Eve unpaid Spring
    await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring", memberIds: [mUnpaidSpring.id] },
    });

    // 6. Fay exempt
    await t.db.insert(clubFee).values({
      id: "cf_exempt_fay",
      memberId: mExempt.id,
      clubYear: 2026,
      season: "fall",
      kind: "exempt",
      amountSek: 0,
      note: "Board exempt",
      recordedBy: admin.id,
    });

    const res = await call(admin, "GET", "/admin/club-fees");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      clubYear: 2026,
      label: "2026/2027",
      fallFeeSek: 180,
      springFeeSek: 90,
      availableYears: [2026, 2025],
      summary: {
        totalMembers: 8, // 7 seeded + admin
        paidFallCount: 2,
        paidFallInAppCount: 1,
        paidFallExternalCount: 1,
        owesFallCount: 1,
        springCount: 2,
        paidSpringCount: 1,
        owesSpringCount: 1,
        exemptCount: 1,
        notChargedCount: 2, // Gus + admin
      },
    });

    const byId = new Map<string, Record<string, unknown>>(
      (res.body.members as Array<Record<string, unknown>>).map((m) => [m.memberId as string, m]),
    );
    expect(byId.has(mNotCharged.id)).toBe(true);
    expect(byId.get(mPaidFall.id)).toMatchObject({
      status: "paid_fall",
      paidInFall: true,
      amountSek: 180,
      oweAmountSek: 0,
    });
    expect(byId.get(mExtFall.id)).toMatchObject({
      status: "paid_fall_external",
      paidInFall: true,
      amountSek: 0,
      oweAmountSek: 0,
      note: "Swish to old account",
    });
    expect(byId.get(mUnpaidFall.id)).toMatchObject({
      status: "charged_fall_unpaid",
      paidInFall: false,
      amountSek: 180,
      oweAmountSek: 120,
    });
    expect(byId.get(mPaidSpring.id)).toMatchObject({
      status: "paid_spring",
      paidInFall: false,
      amountSek: 90,
      oweAmountSek: 0,
    });
    expect(byId.get(mUnpaidSpring.id)).toMatchObject({
      status: "charged_spring_unpaid",
      paidInFall: false,
      amountSek: 90,
      oweAmountSek: 90,
    });
    expect(byId.get(mExempt.id)).toMatchObject({
      status: "exempt",
      paidInFall: false,
    });
    expect(byId.get(mNotCharged.id)).toMatchObject({
      status: "not_charged",
      paidInFall: false,
    });
  });

  it("batch-charges active members and skips already-covered (including Fall payers when charging Spring)", async () => {
    const fallInApp = await makeMember(t.db, { displayName: "Fall InApp" });
    const fallExternal = await makeMember(t.db, { displayName: "Fall External" });
    const springJoiner = await makeMember(t.db, { displayName: "Spring Joiner" });
    const inactive = await makeMember(t.db, { displayName: "Exited", status: "inactive" });

    // Mark fallExternal outside app, charge fallInApp in Fall.
    await call(admin, "POST", "/admin/club-fees/mark-external-fall", {
      body: { clubYear: 2026, memberIds: [fallExternal.id] },
    });
    await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [fallInApp.id] },
    });

    // Now batch-charge Spring for all active members (memberIds omitted).
    const springBatch = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring" },
      key: "spring-batch-1",
    });
    expect(springBatch.status).toBe(200);
    // admin + springJoiner charged; fallInApp + fallExternal skipped; inactive not even targeted.
    expect(springBatch.body.chargedCount).toBe(2);
    expect(springBatch.body.skippedCount).toBe(2);
    expect(springBatch.body.chargedMemberIds.sort()).toEqual([admin.id, springJoiner.id].sort());

    const ledger = createLedgerService({ db: t.db, clock });
    expect(await ledger.balance(fallInApp.id)).toBe(160);
    expect(await ledger.balance(fallExternal.id)).toBe(0);
    expect(await ledger.balance(springJoiner.id)).toBe(85);
    expect(await ledger.balance(inactive.id)).toBe(0);

    // Replay returns cached response without double charging.
    const replay = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring" },
      key: "spring-batch-1",
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await ledger.balance(springJoiner.id)).toBe(85);
  });

  it("clears external_fall_paid mistakes, refuses clearing in-app charges, and allows re-charging after reversal", async () => {
    const m1 = await makeMember(t.db, { displayName: "Mistaken External" });
    const m2 = await makeMember(t.db, { displayName: "InApp Charged" });

    const mark = await call(admin, "POST", "/admin/club-fees/mark-external-fall", {
      body: { clubYear: 2026, memberIds: [m1.id] },
    });
    expect(mark.body).toEqual({ markedCount: 1, skippedCount: 0 });

    const charge = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [m2.id] },
    });
    expect(charge.body.chargedCount).toBe(1);

    const list1 = await call(admin, "GET", "/admin/club-fees?clubYear=2026");
    const row1 = (list1.body.members as Array<{ memberId: string; clubFeeId: string }>).find(
      (m) => m.memberId === m1.id,
    )!;
    const row2 = (
      list1.body.members as Array<{ memberId: string; clubFeeId: string; ledgerEntryId: string }>
    ).find((m) => m.memberId === m2.id)!;

    // Cannot clear an in-app charge directly.
    const refused = await call(admin, "POST", `/admin/club-fees/${row2.clubFeeId}/clear`, {
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("reverse_in_ledger");

    // Can clear external mark.
    const cleared = await call(admin, "POST", `/admin/club-fees/${row1.clubFeeId}/clear`, {
      body: {},
    });
    expect(cleared.status).toBe(200);
    expect(await t.db.select().from(clubFee).where(eq(clubFee.memberId, m1.id))).toHaveLength(0);
    expect((await call(admin, "POST", "/admin/club-fees/missing/clear", { body: {} })).status).toBe(
      404,
    );

    // Reverse m2's ledger charge and verify m2 can be charged again (:v2).
    await createLedgerService({ db: t.db, clock }).reverse({
      entryId: row2.ledgerEntryId,
      note: "Wrong year",
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "rev-m2",
    });

    const recharge = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring", memberIds: [m2.id] },
    });
    expect(recharge.status).toBe(200);
    expect(recharge.body).toEqual({
      chargedCount: 1,
      skippedCount: 0,
      chargedMemberIds: [m2.id],
    });
    const entriesM2 = await t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, m2.id));
    expect(entriesM2.some((e) => e.idempotencyKey === `club-fee:2026:${m2.id}:v2`)).toBe(true);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entity, "club_fee"));
    expect(audits.map((a) => a.action)).toContain("club_fee.clear");
    expect(audits.map((a) => a.action)).toContain("club_fee.mark_external_fall");
    expect(audits.map((a) => a.action)).toContain("club_fee.charge");
  });

  it("treats waiver-reversed club fees as covered/exempt in GET, ensureClubFeeForMember, and batch charge, while allowing re-charge after correction", async () => {
    const waived = await makeMember(t.db, { displayName: "Waived Member" });
    const corrected = await makeMember(t.db, { displayName: "Corrected Member" });

    const charge = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [waived.id, corrected.id] },
    });
    expect(charge.status).toBe(200);
    expect(charge.body.chargedCount).toBe(2);

    const listBefore = await call(admin, "GET", "/admin/club-fees?clubYear=2026");
    const waivedRow = (
      listBefore.body.members as Array<{ memberId: string; ledgerEntryId: string }>
    ).find((m) => m.memberId === waived.id)!;
    const correctedRow = (
      listBefore.body.members as Array<{ memberId: string; ledgerEntryId: string }>
    ).find((m) => m.memberId === corrected.id)!;

    const ledger = createLedgerService({ db: t.db, clock });
    await ledger.reverse({
      entryId: waivedRow.ledgerEntryId,
      reason: "waiver",
      note: "Board waiver",
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "waive-cf-1",
    });
    await ledger.reverse({
      entryId: correctedRow.ledgerEntryId,
      reason: "manual",
      note: "Charged by mistake",
      actor: { ...admin, seriesIds: [] },
      idempotencyKey: "correct-cf-1",
    });

    // GET /admin/club-fees: waived -> exempt (oweAmountSek 0), corrected -> not_charged.
    const listAfter = await call(admin, "GET", "/admin/club-fees?clubYear=2026");
    const membersAfter = listAfter.body.members as Array<{
      memberId: string;
      status: string;
      oweAmountSek: number;
    }>;
    expect(membersAfter.find((m) => m.memberId === waived.id)).toMatchObject({
      status: "exempt",
      oweAmountSek: 0,
    });
    expect(membersAfter.find((m) => m.memberId === corrected.id)).toMatchObject({
      status: "not_charged",
      oweAmountSek: 0,
    });
    expect(listAfter.body.summary.exemptCount).toBe(1);

    // ensureClubFeeForMember (used by issuePass): skips waived member.
    const ensuredWaived = await t.db.transaction((tx) =>
      ensureClubFeeForMember(tx, clock, {
        memberId: waived.id,
        clubYear: 2026,
        season: "fall",
      }),
    );
    expect(ensuredWaived).toEqual({ charged: false, skippedReason: "already_covered" });

    // Batch charge: skips waived member, re-charges corrected member (:v2).
    const recharge = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "spring", memberIds: [waived.id, corrected.id] },
    });
    expect(recharge.status).toBe(200);
    expect(recharge.body).toEqual({
      chargedCount: 1,
      skippedCount: 1,
      chargedMemberIds: [corrected.id],
    });

    const waivedEntries = await t.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.memberId, waived.id));
    expect(waivedEntries).toHaveLength(2); // original charge + waiver reversal, no :v2
    expect(await ledger.balance(waived.id)).toBe(0);
  });

  it("skips erased and pending members when explicit memberIds are passed to POST /admin/club-fees/charge", async () => {
    const active = await makeMember(t.db, { status: "active", displayName: "Active M" });
    const pending = await makeMember(t.db, { status: "pending", displayName: "Pending M" });
    const erased = await makeMember(t.db, { status: "erased", displayName: "Erased M" });

    const res = await call(admin, "POST", "/admin/club-fees/charge", {
      body: { clubYear: 2026, season: "fall", memberIds: [active.id, pending.id, erased.id] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chargedCount: 1,
      skippedCount: 2,
      chargedMemberIds: [active.id],
    });
    expect(await t.db.select().from(clubFee).where(eq(clubFee.memberId, pending.id))).toHaveLength(
      0,
    );
    expect(await t.db.select().from(clubFee).where(eq(clubFee.memberId, erased.id))).toHaveLength(
      0,
    );
  });
});
