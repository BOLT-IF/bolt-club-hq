import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "../../../db/schema";
import {
  auditLog,
  clubFee,
  event,
  eventEligibleMember,
  guest,
  idempotencyRecord,
  invite,
  joinRequest,
  ledgerEntry,
  member,
  notification,
  notificationPref,
  notificationSendLog,
  outboundPush,
  pass,
  paymentClaim,
  poll,
  pollOption,
  pollVote,
  pushSubscription,
  reminderRule,
  rsvp,
  series,
  seriesCaptain,
  seriesDiscountEligible,
  term,
} from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { mountBackendRoutes } from "../registry";
import { tickHooks } from "../scheduler/registry";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeLedgerEntry, makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";
import { configureClerkErase, createClerkUserDeleter } from "./clerk";
import {
  POLL_IMAGE_RETENTION_DAYS,
  PRIVACY_RETENTION_HOOK,
  SEND_LOG_RETENTION_DAYS,
  runRetentionPurge,
} from "./retention";

const NOW = "2027-06-01T12:00:00.000Z";
const DAY_MS = 86_400_000;
const testEnv = { ENV: "test", CLERK_SECRET_KEY: "sk_test_privacy" } as unknown as Cloudflare.Env;

/**
 * Schema-driven classification of every table in `db/schema/`.
 * Adding a new table or PII column in `db/schema/` will fail the schema-driven test
 * until it is either included in `/me/export` or explicitly justified as non-PII.
 */
const EXPORT_TABLE_SPEC: Record<string, { exportKey: string; excludedColumns: readonly string[] }> =
  {
    member: { exportKey: "member", excludedColumns: [] },
    join_request: { exportKey: "joinRequests", excludedColumns: [] },
    series_captain: { exportKey: "seriesCaptains", excludedColumns: [] },
    series_discount_eligible: { exportKey: "seriesDiscountEligibles", excludedColumns: [] },
    event_eligible_member: { exportKey: "eventEligibilities", excludedColumns: [] },
    pass: { exportKey: "passes", excludedColumns: ["grantedBy"] },
    rsvp: { exportKey: "rsvps", excludedColumns: [] },
    guest: { exportKey: "guests", excludedColumns: [] },
    ledger_entry: { exportKey: "ledgerEntries", excludedColumns: ["createdBy"] },
    club_fee: { exportKey: "clubFees", excludedColumns: ["recordedBy"] },
    payment_claim: { exportKey: "paymentClaims", excludedColumns: ["decidedBy"] },
    notification: { exportKey: "notifications", excludedColumns: [] },
    push_subscription: { exportKey: "pushSubscriptions", excludedColumns: ["keys"] },
    notification_pref: { exportKey: "notificationPrefs", excludedColumns: [] },
    notification_send_log: { exportKey: "notificationSendLogs", excludedColumns: [] },
    poll_vote: { exportKey: "pollVotes", excludedColumns: [] },
    audit_log: { exportKey: "auditLogs", excludedColumns: [] },
  };

const NON_PII_TABLES = new Set([
  "invite",
  "idempotency_record",
  "club_settings",
  "term",
  "series",
  "event",
  "reminder_rule",
  "outbound_push",
  "scheduler_state",
  "poll",
  "poll_option",
  "domain_event_outbox",
]);

const SENSITIVE_PII_COLUMNS = new Set([
  "displayName",
  "email",
  "rosterName",
  "clerkUserId",
  "paymentRef",
  "endpoint",
  "userAgent",
  "memberId",
]);

describe("privacy: export, erasure, retention (S2.5)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  const app = new Hono<AppEnv>();
  mountBackendRoutes(app);

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
    configureClerkErase(undefined);
  });

  afterEach(async () => {
    configureClerkErase(undefined);
    configureRequestDeps({});
    await t.close();
  });

  function call(
    clerkUserId: string | null,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const headers: Record<string, string> = {};
    if (clerkUserId) headers[TEST_IDENTITY_HEADER] = clerkUserId;
    if (method === "POST") headers["Idempotency-Key"] = crypto.randomUUID();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return app.request(
      `/api/v1${path}`,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      testEnv,
    );
  }

  async function seedClubFixture(creatorId: string) {
    await t.db.insert(term).values({
      id: "term_1",
      name: "Spring 2027",
      startsOn: "2027-01-01",
      endsOn: "2027-06-30",
      status: "active",
    });
    await t.db.insert(series).values({
      id: "ser_1",
      termId: "term_1",
      name: "Thursday XD",
      format: "XD",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 16,
      passPrice: 1000,
      adhocFee: 120,
      shareSlug: "ser1slug",
      passCap: 10,
    });
    await t.db.insert(event).values({
      id: "evt_1",
      seriesId: "ser_1",
      kind: "series",
      createdBy: creatorId,
      title: "Thursday Night",
      format: "XD",
      startsAt: new Date("2027-06-10T17:00:00.000Z"),
      endsAt: new Date("2027-06-10T18:30:00.000Z"),
      capacity: 16,
      adhocFee: 120,
      rsvpCloseAt: new Date("2027-06-09T17:00:00.000Z"),
      allocationMode: "tiered",
      shareSlug: "evt1slug",
    });
    await t.db.insert(reminderRule).values({
      id: "rule_1",
      category: "payment_due",
      enabled: true,
      params: { thresholdSek: 1 },
      minIntervalDays: 7,
      template: "Pay please",
      updatedBy: creatorId,
    });
    await t.db.insert(poll).values({
      id: "poll_1",
      question: "Shuttle brand?",
      createdBy: creatorId,
      closesAt: new Date("2027-06-20T12:00:00.000Z"),
    });
    await t.db.insert(pollOption).values({
      id: "poll_1_o00",
      pollId: "poll_1",
      label: "Yonex",
    });
  }

  async function seedAllPiiForMember(
    m: typeof member.$inferSelect,
    suffix: string,
    adminId: string,
  ) {
    await t.db
      .update(member)
      .set({
        email: `${suffix}@example.com`,
        rosterName: `Roster ${suffix}`,
      })
      .where(eq(member.id, m.id));

    await t.db.insert(invite).values({
      id: `inv_${suffix}`,
      token: `tok_${suffix}`,
      createdBy: adminId,
      expiresAt: new Date("2027-07-01T00:00:00.000Z"),
      maxUses: 5,
    });
    await t.db.insert(joinRequest).values({
      id: `jr_${suffix}`,
      memberId: m.id,
      via: "invite",
      sourceId: `inv_${suffix}`,
      createdAt: new Date("2027-01-01T10:00:00.000Z"),
    });
    await t.db.insert(seriesCaptain).values({
      seriesId: "ser_1",
      memberId: m.id,
    });
    await t.db.insert(seriesDiscountEligible).values({
      seriesId: "ser_1",
      memberId: m.id,
    });
    await t.db.insert(eventEligibleMember).values({
      eventId: "evt_1",
      memberId: m.id,
    });
    await t.db.insert(pass).values({
      id: `pass_${suffix}`,
      memberId: m.id,
      seriesId: "ser_1",
      priceCharged: 1000,
      eventsCovered: 10,
      status: "active",
      purchasedAt: new Date("2027-01-02T10:00:00.000Z"),
      grantedBy: adminId,
    });
    await t.db.insert(rsvp).values({
      id: `rsvp_${suffix}`,
      eventId: "evt_1",
      memberId: m.id,
      status: "confirmed",
      tier: 1,
      requestedAt: new Date("2027-05-01T10:00:00.000Z"),
    });
    await t.db.insert(guest).values({
      id: `gst_${suffix}`,
      rsvpId: `rsvp_${suffix}`,
      name: `Guest ${suffix}`,
      status: "confirmed",
      tier: 3,
      requestedAt: new Date("2027-05-01T10:01:00.000Z"),
    });
    await makeLedgerEntry(t.db, m.id, {
      amountSek: 120,
      reason: "adhoc",
      idempotencyKey: `charge_${suffix}`,
    });
    await t.db.insert(clubFee).values({
      id: `cf_${suffix}`,
      memberId: m.id,
      clubYear: 2026,
      season: "fall",
      kind: "external_fall_paid",
      amountSek: 0,
      note: `Club fee note ${suffix}`,
      recordedBy: adminId,
    });
    await t.db.insert(paymentClaim).values({
      id: `claim_${suffix}`,
      memberId: m.id,
      amountSek: 120,
      paidOn: new Date("2027-05-02T10:00:00.000Z"),
      note: `Claim note ${suffix}`,
      status: "pending",
      decidedBy: adminId,
    });
    await t.db.insert(notification).values({
      id: `ntf_${suffix}`,
      memberId: m.id,
      category: "rsvp_status",
      title: `Title ${suffix}`,
      body: `Body ${suffix}`,
      link: "/events",
      idempotencyKey: `ntf_key_${suffix}`,
    });
    await t.db.insert(outboundPush).values({
      id: `push_${suffix}`,
      notificationId: `ntf_${suffix}`,
      status: "queued",
    });
    await t.db.insert(pushSubscription).values({
      id: `sub_${suffix}`,
      memberId: m.id,
      endpoint: `https://push.example.com/${suffix}`,
      keys: { p256dh: `pub_${suffix}`, auth: `auth_${suffix}` },
      userAgent: `BoltUA/${suffix}`,
      createdAt: new Date("2027-05-03T10:00:00.000Z"),
    });
    await t.db.insert(notificationPref).values({
      memberId: m.id,
      category: "polls",
      muted: true,
    });
    await t.db.insert(notificationSendLog).values({
      id: `send_${suffix}`,
      memberId: m.id,
      category: "payment_due",
      ruleId: "rule_1",
      sentAt: new Date("2027-05-04T10:00:00.000Z"),
    });
    await t.db.insert(pollVote).values({
      pollId: "poll_1",
      optionId: "poll_1_o00",
      memberId: m.id,
      votedAt: new Date("2027-05-05T10:00:00.000Z"),
    });
    await t.db.insert(auditLog).values({
      id: `aud_${suffix}`,
      actorId: adminId,
      action: "member.update",
      entity: "member",
      entityId: m.id,
      before: JSON.stringify({ displayName: `Old ${suffix}`, email: `old_${suffix}@example.com` }),
      after: JSON.stringify({ displayName: m.displayName, email: `${suffix}@example.com` }),
      at: new Date("2027-05-06T10:00:00.000Z"),
    });
  }

  describe("GET /me/export", () => {
    it("covers every PII table and column in db/schema (schema-driven)", async () => {
      const schemaTables: PgTable[] = (Object.values(schema) as unknown[]).filter(
        (value): value is PgTable => is(value, PgTable),
      );
      expect(schemaTables.length).toBeGreaterThanOrEqual(22);

      for (const table of schemaTables) {
        const name = getTableConfig(table).name;
        const columns = Object.keys(getTableColumns(table));
        const inExport = name in EXPORT_TABLE_SPEC;
        const inNonPii = NON_PII_TABLES.has(name);
        expect(inExport || inNonPii, `unclassified table in db/schema: ${name}`).toBe(true);
        expect(inExport && inNonPii, `table in both specs: ${name}`).toBe(false);
        if (inNonPii) {
          const piiHits = columns.filter((col) => SENSITIVE_PII_COLUMNS.has(col));
          expect(piiHits, `non-PII table ${name} contains PII columns`).toEqual([]);
        }
      }

      const admin = await makeMember(t.db, { role: "admin", displayName: "Admin User" });
      await seedClubFixture(admin.id);
      const target = await makeMember(t.db, { displayName: "Target User" });
      const other = await makeMember(t.db, { displayName: "Other User" });
      await seedAllPiiForMember(target, "target1", admin.id);
      await seedAllPiiForMember(other, "other2", admin.id);

      const res = await call(target.clerkUserId, "GET", "/me/export");
      expect(res.status).toBe(200);
      const payload = await res.json<Record<string, unknown>>();
      expect(typeof payload.exportedAt).toBe("string");

      for (const table of schemaTables) {
        const tableName = getTableConfig(table).name;
        const spec = EXPORT_TABLE_SPEC[tableName];
        if (!spec) continue;
        const value = payload[spec.exportKey];
        expect(value, `missing export section ${spec.exportKey}`).toBeDefined();
        const rows = Array.isArray(value)
          ? (value as Record<string, unknown>[])
          : [value as Record<string, unknown>];
        expect(rows.length, `expected rows for ${spec.exportKey}`).toBeGreaterThan(0);

        const firstRow = rows[0]!;
        for (const col of Object.keys(getTableColumns(table))) {
          if (spec.excludedColumns.includes(col)) {
            expect(firstRow).not.toHaveProperty(col);
          } else {
            expect(firstRow, `missing column ${tableName}.${col} in export`).toHaveProperty(col);
          }
        }
      }

      const serialized = JSON.stringify(payload);
      expect(serialized).toContain("target1@example.com");
      expect(serialized).toContain("Roster target1");
      expect(serialized).toContain("Guest target1");
      expect(serialized).toContain("https://push.example.com/target1");
      expect(serialized).toContain("BoltUA/target1");
      expect(serialized).toContain("Claim note target1");
      expect(serialized).not.toContain("other2");
      expect(serialized).not.toContain("pub_target1");
      expect(serialized).not.toContain("auth_target1");
    });

    it("allows inactive (exited) members to export their data, and refuses anonymous/pending/erased", async () => {
      const inactive = await makeMember(t.db, { status: "inactive", displayName: "Exited Member" });
      const pending = await makeMember(t.db, { status: "pending" });
      const erased = await makeMember(t.db, { status: "erased" });

      expect((await call(null, "GET", "/me/export")).status).toBe(401);
      expect((await call(pending.clerkUserId, "GET", "/me/export")).status).toBe(403);
      expect((await call(erased.clerkUserId, "GET", "/me/export")).status).toBe(403);

      const res = await call(inactive.clerkUserId, "GET", "/me/export");
      expect(res.status).toBe(200);
      const data = await res.json<{ member: { id: string; status: string } }>();
      expect(data.member.id).toBe(inactive.id);
      expect(data.member.status).toBe("inactive");
    });
  });

  describe("POST /admin/members/:id/erase", () => {
    it("is admin only and refuses non-zero balance with 409", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db);
      const debtor = await makeMember(t.db, { displayName: "Debtor Member" });
      await makeLedgerEntry(t.db, debtor.id, { amountSek: 120, reason: "adhoc" });

      expect((await call(null, "POST", `/admin/members/${debtor.id}/erase`)).status).toBe(401);
      expect(
        (await call(plain.clerkUserId, "POST", `/admin/members/${debtor.id}/erase`)).status,
      ).toBe(403);
      expect(
        (await call(admin.clerkUserId, "POST", "/admin/members/nonexistent/erase")).status,
      ).toBe(404);

      const denied = await call(admin.clerkUserId, "POST", `/admin/members/${debtor.id}/erase`);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: "nonzero_balance", balanceSek: 120 });

      // Credit (negative balance) is also non-zero and refused.
      const creditor = await makeMember(t.db);
      await makeLedgerEntry(t.db, creditor.id, {
        amountSek: -50,
        kind: "payment",
        reason: "payment",
      });
      expect(
        (await call(admin.clerkUserId, "POST", `/admin/members/${creditor.id}/erase`)).status,
      ).toBe(409);
    });

    it("refuses erasing the last active admin", async () => {
      const onlyAdmin = await makeMember(t.db, { role: "admin" });
      const res = await call(onlyAdmin.clerkUserId, "POST", `/admin/members/${onlyAdmin.id}/erase`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "last_admin" });
    });

    it("strips all PII, keeps ledger sums unchanged, pseudonymizes audit JSON, and deletes the Clerk user", async () => {
      const admin = await makeMember(t.db, { role: "admin", displayName: "Club Admin" });
      await seedClubFixture(admin.id);
      const target = await makeMember(t.db, {
        displayName: "Alice Secret",
        status: "inactive",
      });
      const originalClerkId = target.clerkUserId;
      await seedAllPiiForMember(target, "alice", admin.id);
      // Settle the 120 kr charge with a -120 kr waiver so net balance is 0.
      await makeLedgerEntry(t.db, target.id, {
        amountSek: -120,
        kind: "adjustment",
        reason: "waiver",
        idempotencyKey: "waiver_alice",
      });
      await t.db.insert(idempotencyRecord).values({
        key: "idem_alice",
        actorId: target.id,
        route: "POST /api/v1/me/payment-claims",
        responseStatus: 201,
        responseBody: JSON.stringify({ name: "Alice Secret" }),
      });
      // Admin notification from target's join request also contains target's display name.
      await t.db.insert(notification).values({
        id: "ntf_admin_jr",
        memberId: admin.id,
        category: "admin_tasks",
        title: "New join request",
        body: "Alice Secret asked to join the club.",
        idempotencyKey: `join-request:jr_alice:${admin.id}`,
      });

      const clerkCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
      const mockFetch: typeof fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        clerkCalls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 200 }));
      };
      configureClerkErase(createClerkUserDeleter(mockFetch));

      const [sumBeforeRow] = await t.db
        .select({ sum: sql<string>`coalesce(sum(${ledgerEntry.amountSek}), 0)` })
        .from(ledgerEntry);
      const [countBeforeRow] = await t.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ledgerEntry);
      const sumBefore = sumBeforeRow?.sum;
      const countBefore = countBeforeRow?.count;

      const res = await call(admin.clerkUserId, "POST", `/admin/members/${target.id}/erase`);
      expect(res.status).toBe(200);
      const body = await res.json<{
        member: { id: string; status: string; displayName: string };
      }>();
      expect(body.member).toEqual({
        id: target.id,
        status: "erased",
        displayName: `Former member #${target.id}`,
      });

      // Clerk DELETE called once with Bearer CLERK_SECRET_KEY.
      expect(clerkCalls).toHaveLength(1);
      expect(clerkCalls[0]?.url).toBe(
        `https://api.clerk.com/v1/users/${encodeURIComponent(originalClerkId)}`,
      );
      expect(clerkCalls[0]?.init?.method).toBe("DELETE");
      expect(new Headers(clerkCalls[0]?.init?.headers).get("Authorization")).toBe(
        "Bearer sk_test_privacy",
      );

      // Member row stripped of PII.
      const [erasedMember] = await t.db.select().from(member).where(eq(member.id, target.id));
      expect(erasedMember).toMatchObject({
        id: target.id,
        displayName: `Former member #${target.id}`,
        email: null,
        rosterName: null,
        status: "erased",
        role: "member",
      });
      expect(erasedMember?.clerkUserId).not.toBe(originalClerkId);
      expect(erasedMember?.clerkUserId).toMatch(/^erased:/);
      expect(erasedMember?.paymentRef).toMatch(/^ERASED-/);

      // Push subscriptions, preferences, captaincies, join requests, notifications, idempotency deleted.
      expect(
        await t.db.select().from(pushSubscription).where(eq(pushSubscription.memberId, target.id)),
      ).toHaveLength(0);
      expect(
        await t.db.select().from(notificationPref).where(eq(notificationPref.memberId, target.id)),
      ).toHaveLength(0);
      expect(
        await t.db.select().from(seriesCaptain).where(eq(seriesCaptain.memberId, target.id)),
      ).toHaveLength(0);
      expect(
        await t.db.select().from(joinRequest).where(eq(joinRequest.memberId, target.id)),
      ).toHaveLength(0);
      expect(
        await t.db.select().from(notification).where(eq(notification.memberId, target.id)),
      ).toHaveLength(0);
      expect(
        await t.db.select().from(idempotencyRecord).where(eq(idempotencyRecord.actorId, target.id)),
      ).toHaveLength(0);

      // Guest names scrubbed to "Guest", claim note cleared, admin join-request notification scrubbed.
      const [scrubbedGuest] = await t.db.select().from(guest).where(eq(guest.id, "gst_alice"));
      expect(scrubbedGuest?.name).toBe("Guest");
      const [scrubbedClaim] = await t.db
        .select()
        .from(paymentClaim)
        .where(eq(paymentClaim.id, "claim_alice"));
      expect(scrubbedClaim?.note).toBeNull();
      const [adminNtf] = await t.db
        .select()
        .from(notification)
        .where(eq(notification.id, "ntf_admin_jr"));
      expect(adminNtf?.body).not.toContain("Alice Secret");

      // Audit JSON pseudonymized and member.erase audited without PII.
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entityId, target.id));
      expect(audits.some((a) => a.action === "member.erase")).toBe(true);
      const serializedAudits = JSON.stringify(audits);
      expect(serializedAudits).not.toContain("Alice Secret");
      expect(serializedAudits).not.toContain("Old alice");
      expect(serializedAudits).not.toContain("alice@example.com");

      // Ledger entries and sums completely unchanged.
      const [sumAfterRow] = await t.db
        .select({ sum: sql<string>`coalesce(sum(${ledgerEntry.amountSek}), 0)` })
        .from(ledgerEntry);
      const [countAfterRow] = await t.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ledgerEntry);
      expect(sumAfterRow?.sum).toBe(sumBefore);
      expect(countAfterRow?.count).toBe(countBefore);

      // Erased member can no longer export or authenticate.
      expect((await call(originalClerkId, "GET", "/me/export")).status).toBe(401);

      // Idempotent on repeat call without calling Clerk again.
      const repeat = await call(admin.clerkUserId, "POST", `/admin/members/${target.id}/erase`);
      expect(repeat.status).toBe(200);
      expect(clerkCalls).toHaveLength(1);
    });

    it("rolls back DB erasure if Clerk deletion fails", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const target = await makeMember(t.db, { displayName: "Bob Rollback" });

      configureClerkErase(
        createClerkUserDeleter(() =>
          Promise.resolve(new Response("upstream error", { status: 500 })),
        ),
      );

      const res = await call(admin.clerkUserId, "POST", `/admin/members/${target.id}/erase`);
      expect(res.status).toBe(502);

      const [stillIntact] = await t.db.select().from(member).where(eq(member.id, target.id));
      expect(stillIntact?.status).toBe("active");
      expect(stillIntact?.displayName).toBe("Bob Rollback");
      expect(stillIntact?.clerkUserId).toBe(target.clerkUserId);
    });

    it("cancels future pre-close RSVPs when erasing an active member", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      await seedClubFixture(admin.id);
      const active = await makeMember(t.db, { status: "active", displayName: "Active Leaver" });
      await t.db.insert(rsvp).values({
        id: "rsvp_open_future",
        eventId: "evt_1",
        memberId: active.id,
        status: "confirmed",
        tier: 2,
        requestedAt: new Date("2027-05-01T10:00:00.000Z"),
      });

      configureClerkErase(
        createClerkUserDeleter(() => Promise.resolve(new Response(null, { status: 200 }))),
      );

      const res = await call(admin.clerkUserId, "POST", `/admin/members/${active.id}/erase`);
      expect(res.status).toBe(200);

      const [updatedRsvp] = await t.db.select().from(rsvp).where(eq(rsvp.id, "rsvp_open_future"));
      expect(updatedRsvp?.status).toBe("cancelled");
    });
  });

  describe("retention purge cron hook", () => {
    it("registers the retention purge tick hook at module load", () => {
      expect(tickHooks().has(PRIVACY_RETENTION_HOOK)).toBe(true);
    });

    it("deletes only notification_send_log and poll images past their retention windows", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const m = await makeMember(t.db);
      const now = clock.now();
      const sendCutoff = now.getTime() - SEND_LOG_RETENTION_DAYS * DAY_MS;
      const pollCutoff = now.getTime() - POLL_IMAGE_RETENTION_DAYS * DAY_MS;

      await t.db.insert(notificationSendLog).values([
        {
          id: "log_expired",
          memberId: m.id,
          category: "payment_due",
          sentAt: new Date(sendCutoff - 1000),
        },
        {
          id: "log_boundary",
          memberId: m.id,
          category: "payment_due",
          sentAt: new Date(sendCutoff),
        },
        {
          id: "log_recent",
          memberId: m.id,
          category: "payment_due",
          sentAt: new Date(sendCutoff + DAY_MS),
        },
      ]);

      await t.db.insert(poll).values([
        {
          id: "poll_old",
          question: "Old poll",
          createdBy: admin.id,
          closesAt: new Date(pollCutoff - 1000),
        },
        {
          id: "poll_boundary",
          question: "Boundary poll",
          createdBy: admin.id,
          closesAt: new Date(pollCutoff),
        },
        {
          id: "poll_recent",
          question: "Recent poll",
          createdBy: admin.id,
          closesAt: new Date(pollCutoff + DAY_MS),
        },
        {
          id: "poll_open",
          question: "Never closes",
          createdBy: admin.id,
          closesAt: null,
        },
      ]);

      await t.db.insert(pollOption).values([
        { id: "opt_old_img", pollId: "poll_old", label: "A", imageKey: "polls/old.webp" },
        { id: "opt_old_noimg", pollId: "poll_old", label: "B", imageKey: null },
        {
          id: "opt_boundary_img",
          pollId: "poll_boundary",
          label: "C",
          imageKey: "polls/boundary.webp",
        },
        { id: "opt_recent_img", pollId: "poll_recent", label: "D", imageKey: "polls/recent.webp" },
        { id: "opt_open_img", pollId: "poll_open", label: "E", imageKey: "polls/open.webp" },
      ]);

      const deleteMedia = vi.fn(() => Promise.resolve());
      const result = await runRetentionPurge(
        { db: t.db, clock, now },
        { media: { delete: deleteMedia } },
      );

      expect(result).toEqual({ sendLogsDeleted: 1, pollImagesDeleted: 1 });

      const remainingLogs = (await t.db.select().from(notificationSendLog)).map((r) => r.id).sort();
      expect(remainingLogs).toEqual(["log_boundary", "log_recent"]);

      expect(deleteMedia).toHaveBeenCalledTimes(1);
      expect(deleteMedia).toHaveBeenCalledWith("polls/old.webp");

      const options = await t.db.select().from(pollOption);
      const imageOf = (id: string) => options.find((o) => o.id === id)?.imageKey;
      expect(imageOf("opt_old_img")).toBeNull();
      expect(imageOf("opt_boundary_img")).toBe("polls/boundary.webp");
      expect(imageOf("opt_recent_img")).toBe("polls/recent.webp");
      expect(imageOf("opt_open_img")).toBe("polls/open.webp");
    });
  });
});
