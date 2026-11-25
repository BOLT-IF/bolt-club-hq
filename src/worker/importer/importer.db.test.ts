import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { auditLog, ledgerEntry, member } from "../../../db/schema";
import { clerkRequestDeps } from "../auth/wiring";
import {
  TEST_PUBLISHABLE_KEY,
  bearer,
  createTestSigner,
  jwksFetch,
  type TestSigner,
} from "../auth/test-jwt";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createLedgerService } from "../ledger/service";
import { mountBackendRoutes } from "../registry";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import type { AppEnv } from "../types";

const NOW = "2027-02-01T10:00:00.000Z";
const BOOTSTRAP = "boss@club.test";
const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;
const devEnv = {
  ENV: "dev",
  CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
  BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP,
} as unknown as Cloudflare.Env;

type MemberRow = typeof member.$inferSelect;

interface ImportResponse {
  createdMembers: number;
  existingMembers: number;
  openingEntriesCreated: number;
  openingEntriesExisting: number;
  results: Array<{
    row: number;
    memberId: string;
    email: string;
    memberAction: "created" | "existing";
    openingBalanceSek: number;
    openingEntryId: string | null;
    openingEntryCreated: boolean;
  }>;
}

describe("Member import with opening balances (S11.2)", () => {
  let t: TestDatabase;
  let clock: FixedClock;
  const app = new Hono<AppEnv>();
  mountBackendRoutes(app);

  beforeEach(async () => {
    t = await createTestDatabase();
    clock = new FixedClock(NOW);
    configureRequestDeps({ db: () => Promise.resolve(t.db), clock });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  function postImport(
    as: MemberRow | null,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    return Promise.resolve(
      app.request(
        "/api/v1/admin/members/import",
        { method: "POST", headers, body: JSON.stringify(body) },
        testEnv,
      ),
    );
  }

  describe("permissions and idempotency key", () => {
    it("allows only active admins and requires Idempotency-Key", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const plain = await makeMember(t.db, { role: "member" });
      const pending = await makeMember(t.db, { role: "admin", status: "pending" });
      const inactive = await makeMember(t.db, { role: "admin", status: "inactive" });
      const body = {
        rows: [{ displayName: "Ada", email: "ada@club.test", openingBalanceSek: 0 }],
      };

      expect((await postImport(null, body, "k-anon")).status).toBe(401);
      expect((await postImport(plain, body, "k-member")).status).toBe(403);
      expect((await postImport(pending, body, "k-pending")).status).toBe(403);
      expect((await postImport(inactive, body, "k-inactive")).status).toBe(403);
      expect((await postImport(admin, body)).status).toBe(400);
    });
  });

  describe("balances import exactly", () => {
    it("pre-provisions members and records exact positive, negative and zero opening balances", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const payload = {
        rows: [
          {
            displayName: "Ada Lovelace",
            email: "Ada@Club.Test",
            rosterName: "Ada L",
            openingBalanceSek: 450,
            note: "Autumn term carry-over",
          },
          {
            displayName: "Grace Hopper",
            email: "grace@club.test",
            role: "admin",
            paymentRef: "bc-grace1",
            openingBalanceSek: -120,
          },
          {
            displayName: "Alan Turing",
            email: "alan@club.test",
            status: "inactive",
            openingBalanceSek: 0,
          },
        ],
      };

      const res = await postImport(admin, payload, "imp-1");
      expect(res.status).toBe(200);
      const data = await res.json<ImportResponse>();
      expect(data.createdMembers).toBe(3);
      expect(data.existingMembers).toBe(0);
      expect(data.openingEntriesCreated).toBe(2);
      expect(data.openingEntriesExisting).toBe(0);
      expect(JSON.stringify(data)).not.toContain("preprovisioned:");

      const ledger = createLedgerService({ db: t.db, clock });

      const [ada] = await t.db.select().from(member).where(eq(member.email, "ada@club.test"));
      expect(ada).toBeDefined();
      expect(ada?.clerkUserId).toBe(`preprovisioned:${ada!.id}`);
      expect(ada?.displayName).toBe("Ada Lovelace");
      expect(ada?.rosterName).toBe("Ada L");
      expect(ada?.role).toBe("member");
      expect(ada?.status).toBe("active");
      expect(ada?.paymentRef).toMatch(/^BC-/);
      expect(ada?.joinedAt?.toISOString()).toBe(NOW);
      expect(await ledger.balance(ada!.id)).toBe(450);

      const [adaEntry] = await t.db
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.memberId, ada!.id));
      expect(adaEntry).toMatchObject({
        kind: "adjustment",
        reason: "opening_balance",
        amountSek: 450,
        note: "Autumn term carry-over",
        idempotencyKey: `import-opening:${ada!.id}`,
      });

      const [grace] = await t.db.select().from(member).where(eq(member.email, "grace@club.test"));
      expect(grace?.role).toBe("admin");
      expect(grace?.paymentRef).toBe("BC-GRACE1");
      expect(await ledger.balance(grace!.id)).toBe(-120);

      const [alan] = await t.db.select().from(member).where(eq(member.email, "alan@club.test"));
      expect(alan?.status).toBe("inactive");
      expect(alan?.leftAt?.toISOString()).toBe(NOW);
      expect(await ledger.balance(alan!.id)).toBe(0);
      expect(
        await t.db.select().from(ledgerEntry).where(eq(ledgerEntry.memberId, alan!.id)),
      ).toHaveLength(0);

      const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "member.import"));
      expect(audits).toHaveLength(3);
    });
  });

  describe("re-running the import is idempotent", () => {
    it("replays same HTTP Idempotency-Key and stays idempotent across new HTTP keys", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const rows = [
        { displayName: "Ada", email: "ada@club.test", openingBalanceSek: 250 },
        { displayName: "Bob", email: "bob@club.test", openingBalanceSek: -50 },
      ];

      const first = await postImport(admin, { rows }, "http-key-1");
      expect(first.status).toBe(200);
      const firstBody = await first.json<ImportResponse>();

      // Exact HTTP key replay
      const replay = await postImport(admin, { rows }, "http-key-1");
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await replay.json<ImportResponse>()).toEqual(firstBody);

      // Re-run with a new HTTP key, mixed-case emails, plus one additional new member
      const rerun = await postImport(
        admin,
        {
          rows: [
            { displayName: "Ada", email: "ADA@club.test", openingBalanceSek: 250 },
            { displayName: "Bob", email: "BOB@CLUB.TEST", openingBalanceSek: -50 },
            { displayName: "Cara", email: "cara@club.test", openingBalanceSek: 100 },
          ],
        },
        "http-key-2",
      );
      expect(rerun.status).toBe(200);
      const rerunBody = await rerun.json<ImportResponse>();
      expect(rerunBody.createdMembers).toBe(1);
      expect(rerunBody.existingMembers).toBe(2);
      expect(rerunBody.openingEntriesCreated).toBe(1);
      expect(rerunBody.openingEntriesExisting).toBe(2);

      // 1 existing admin + 3 imported members = 4 total
      expect(await t.countMembers()).toBe(4);
      const ledger = createLedgerService({ db: t.db, clock });
      expect(await ledger.balance(firstBody.results[0]!.memberId)).toBe(250);
      expect(await ledger.balance(firstBody.results[1]!.memberId)).toBe(-50);
      expect(await ledger.balance(rerunBody.results[2]!.memberId)).toBe(100);
    });

    it("rejects with 409 idempotency_conflict and rolls back if opening balance changes on re-run", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      expect(
        (
          await postImport(
            admin,
            { rows: [{ displayName: "Ada", email: "ada@club.test", openingBalanceSek: 250 }] },
            "k1",
          )
        ).status,
      ).toBe(200);

      const conflict = await postImport(
        admin,
        {
          rows: [
            { displayName: "New Person", email: "new@club.test", openingBalanceSek: 100 },
            { displayName: "Ada", email: "ada@club.test", openingBalanceSek: 300 },
          ],
        },
        "k2",
      );
      expect(conflict.status).toBe(409);
      // No partial import of "New Person"
      expect(
        await t.db.select().from(member).where(eq(member.email, "new@club.test")),
      ).toHaveLength(0);
    });
  });

  describe("malformed rows are reported with no partial import", () => {
    it("reports all malformed rows with 400 and imports nothing", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const beforeMembers = await t.countMembers();

      const res = await postImport(
        admin,
        {
          rows: [
            { displayName: "Valid Row", email: "valid@club.test", openingBalanceSek: 100 },
            { displayName: "Float Bal", email: "float@club.test", openingBalanceSek: 12.5 },
            { displayName: "Bad Email", email: "not-an-email", openingBalanceSek: 0 },
            { displayName: "   ", email: "blankname@club.test", openingBalanceSek: 50 },
            {
              displayName: "Bad Role",
              email: "role@club.test",
              role: "captain",
              openingBalanceSek: 0,
            },
            { displayName: "Dup Email", email: "VALID@club.test", openingBalanceSek: 25 },
          ],
        },
        "bad-batch-1",
      );

      expect(res.status).toBe(400);
      const body = await res.json<{
        error: string;
        errors: Array<{ row: number; field: string; error: string }>;
      }>();
      expect(body.error).toBe("invalid_import_rows");
      expect(body.errors.map((e) => e.row)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]));
      expect(await t.countMembers()).toBe(beforeMembers);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);
    });

    it("rolls back the whole batch if a later row fails inside the transaction", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const taken = await makeMember(t.db, { displayName: "Existing" });
      await t.db.update(member).set({ paymentRef: "BC-TAKEN1" }).where(eq(member.id, taken.id));

      const res = await postImport(
        admin,
        {
          rows: [
            { displayName: "First", email: "first@club.test", openingBalanceSek: 150 },
            {
              displayName: "Second",
              email: "second@club.test",
              paymentRef: "BC-TAKEN1",
              openingBalanceSek: 50,
            },
          ],
        },
        "tx-rollback-1",
      );

      expect(res.status).toBe(409);
      expect(
        await t.db.select().from(member).where(eq(member.email, "first@club.test")),
      ).toHaveLength(0);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);
    });

    it("enforces self-ledger guard when another active admin exists and rolls back batch", async () => {
      const admin1 = await makeMember(t.db, { role: "admin" });
      await t.db.update(member).set({ email: "admin1@club.test" }).where(eq(member.id, admin1.id));
      await makeMember(t.db, { role: "admin" });

      const res = await postImport(
        admin1,
        {
          rows: [
            { displayName: "Other", email: "other@club.test", openingBalanceSek: 100 },
            { displayName: "Self", email: "admin1@club.test", openingBalanceSek: 50 },
          ],
        },
        "self-ledger-1",
      );
      expect(res.status).toBe(403);
      expect(
        await t.db.select().from(member).where(eq(member.email, "other@club.test")),
      ).toHaveLength(0);
      expect(await t.db.select().from(ledgerEntry)).toHaveLength(0);
    });
  });

  describe("first sign-in links to the imported member, not a duplicate", () => {
    let signer: TestSigner;
    let profiles: Map<string, { email: string | null; name: string | null }>;
    let profileCalls: number;

    beforeAll(async () => {
      signer = await createTestSigner();
    });

    beforeEach(() => {
      profiles = new Map();
      profileCalls = 0;
      configureRequestDeps({
        db: () => Promise.resolve(t.db),
        clock,
        ...clerkRequestDeps({
          clock,
          fetch: jwksFetch(() => [signer]).fetch,
          profile: (_env, clerkUserId) => {
            profileCalls++;
            return Promise.resolve(profiles.get(clerkUserId) ?? { email: null, name: null });
          },
        }),
      });
    });

    const callMe = async (token: string) =>
      app.request("/api/v1/me", { headers: bearer(token) }, devEnv);

    it("links pre-provisioned member by verified email (case-insensitive) without creating a duplicate", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const imp = await postImport(
        admin,
        {
          rows: [
            {
              displayName: "Ada Lovelace",
              email: "ada@club.test",
              rosterName: "Ada L",
              openingBalanceSek: 250,
            },
          ],
        },
        "link-imp-1",
      );
      expect(imp.status).toBe(200);
      const memberId = (await imp.json<ImportResponse>()).results[0]!.memberId;

      profiles.set("user_ada_clerk", { email: "ADA@Club.Test", name: "Clerk Name" });
      const token = await signer.sign({ sub: "user_ada_clerk" });

      const first = await callMe(token);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        id: memberId,
        role: "member",
        status: "active",
      });
      expect(profileCalls).toBe(1);

      // Second sign-in uses clerkUserId directly (no extra Clerk profile fetch)
      const second = await callMe(token);
      expect(second.status).toBe(200);
      expect(profileCalls).toBe(1);

      // Only one member with ada@club.test exists, linked to Clerk and keeping imported fields + balance
      const rows = await t.db
        .select()
        .from(member)
        .where(sql`lower(${member.email}) = 'ada@club.test'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: memberId,
        clerkUserId: "user_ada_clerk",
        displayName: "Ada Lovelace",
        rosterName: "Ada L",
        status: "active",
      });
      expect(await createLedgerService({ db: t.db, clock }).balance(memberId)).toBe(250);

      const linkedAudits = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, memberId), eq(auditLog.action, "member.clerk_linked")));
      expect(linkedAudits).toHaveLength(1);
      const createdAudits = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "member.created"));
      expect(createdAudits).toHaveLength(0);
    });

    it("handles concurrent first sign-ins for a pre-provisioned member cleanly", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const imp = await postImport(
        admin,
        { rows: [{ displayName: "Race", email: "race@club.test", openingBalanceSek: 75 }] },
        "link-race-1",
      );
      expect(imp.status).toBe(200);
      const memberId = (await imp.json<ImportResponse>()).results[0]!.memberId;

      profiles.set("user_race_clerk", { email: "race@club.test", name: "Race" });
      const token = await signer.sign({ sub: "user_race_clerk" });

      const responses = await Promise.all(Array.from({ length: 8 }, () => callMe(token)));
      expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 200));
      const ids = new Set(
        await Promise.all(responses.map(async (r) => (await r.json<{ id: string }>()).id)),
      );
      expect([...ids]).toEqual([memberId]);
      expect(
        await t.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.entityId, memberId), eq(auditLog.action, "member.clerk_linked"))),
      ).toHaveLength(1);
    });

    it("promotes bootstrap admin on link and does not link when Clerk email is unverified/null", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const imp = await postImport(
        admin,
        {
          rows: [
            { displayName: "Club Boss", email: "boss@club.test", openingBalanceSek: 0 },
            { displayName: "Unverified Target", email: "target@club.test", openingBalanceSek: 100 },
          ],
        },
        "link-boot-1",
      );
      expect(imp.status).toBe(200);
      const impData = await imp.json<ImportResponse>();
      const bossId = impData.results[0]!.memberId;
      const targetId = impData.results[1]!.memberId;

      profiles.set("user_boss_clerk", { email: "BOSS@club.test", name: "Boss" });
      const bossRes = await callMe(await signer.sign({ sub: "user_boss_clerk" }));
      expect(bossRes.status).toBe(200);
      expect(await bossRes.json()).toMatchObject({ id: bossId, role: "admin", status: "active" });

      // Null/unverified email must NOT link to target@club.test
      profiles.set("user_unverified", { email: null, name: "Stranger" });
      const strangerRes = await callMe(await signer.sign({ sub: "user_unverified" }));
      expect(strangerRes.status).toBe(200);
      const stranger = await strangerRes.json<{ id: string; status: string }>();
      expect(stranger.id).not.toBe(targetId);
      expect(stranger.status).toBe("pending");
    });

    it("links an inactive pre-provisioned member without auto-reactivating them", async () => {
      const admin = await makeMember(t.db, { role: "admin" });
      const imp = await postImport(
        admin,
        {
          rows: [
            {
              displayName: "Exited Member",
              email: "exited@club.test",
              status: "inactive",
              openingBalanceSek: 320,
            },
          ],
        },
        "link-inactive-1",
      );
      expect(imp.status).toBe(200);
      const memberId = (await imp.json<ImportResponse>()).results[0]!.memberId;

      profiles.set("user_exited_clerk", { email: "exited@club.test", name: "Exited" });
      const res = await callMe(await signer.sign({ sub: "user_exited_clerk" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: memberId, status: "inactive" });
      expect(await createLedgerService({ db: t.db, clock }).balance(memberId)).toBe(320);
    });
  });
});
