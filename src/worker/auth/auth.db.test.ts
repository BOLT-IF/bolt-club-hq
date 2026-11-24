import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { auditLog, member } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { clerkRequestDeps } from "./wiring";
import routes from "./routes";
import {
  TEST_PUBLISHABLE_KEY,
  bearer,
  createTestSigner,
  jwksFetch,
  nowSeconds,
  type TestSigner,
} from "./test-jwt";

const BOOTSTRAP = "Boss@club.test";
// ENV=dev on purpose: the X-Test-Identity override is off, so only real JWTs work.
const env = {
  ENV: "dev",
  CLERK_PUBLISHABLE_KEY: TEST_PUBLISHABLE_KEY,
  BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP,
} as unknown as Cloudflare.Env;

describe("Clerk sign-in (S1.1)", () => {
  let t: TestDatabase;
  let signer: TestSigner;
  let profiles: Map<string, { email: string | null; name: string | null }>;
  let profileCalls: number;

  beforeAll(async () => {
    signer = await createTestSigner();
  });

  beforeEach(async () => {
    t = await createTestDatabase();
    profiles = new Map();
    profileCalls = 0;
    const clock = new FixedClock("2027-01-01T10:00:00Z");
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

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const me = async (token?: string) =>
    routes.request("/me", token ? { headers: bearer(token) } : {}, env);

  it("401 for a missing token", async () => {
    expect((await me()).status).toBe(401);
  });

  it("401 for an expired token", async () => {
    const past = nowSeconds() - 3600;
    const token = await signer.sign({ sub: "user_a", iat: past - 60, nbf: past - 60, exp: past });
    expect((await me(token)).status).toBe(401);
    expect(await t.countMembers()).toBe(0);
  });

  it("401 for a token from the wrong issuer, and creates nothing", async () => {
    const token = await signer.sign({ sub: "user_a", iss: "https://evil.example" });
    expect((await me(token)).status).toBe(401);
    expect(await t.countMembers()).toBe(0);
  });

  it("the first sign-in creates one pending member; the second finds it", async () => {
    profiles.set("user_new", { email: "ada@club.test", name: "Ada Lovelace" });
    const token = await signer.sign({ sub: "user_new" });

    const first = await me(token);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ role: "member", status: "pending", seriesIds: [] });

    const second = await me(token);
    expect(second.status).toBe(200);

    const rows = await t.db.select().from(member).where(eq(member.clerkUserId, "user_new"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      role: "member",
      displayName: "Ada Lovelace",
      email: "ada@club.test",
    });
    expect(rows[0]?.paymentRef).toMatch(/^BC-/);
    expect(profileCalls).toBe(1);
  });

  it("creates exactly one pending member when the first requests arrive concurrently", async () => {
    profiles.set("user_race", { email: "race@club.test", name: "Race" });
    const token = await signer.sign({ sub: "user_race" });

    const responses = await Promise.all(Array.from({ length: 12 }, () => me(token)));

    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 200));
    const ids = new Set(
      await Promise.all(responses.map(async (r) => (await r.json<{ id: string }>()).id)),
    );
    expect(ids.size).toBe(1);
    const rows = await t.db.select().from(member).where(eq(member.clerkUserId, "user_race"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "member.created"));
    expect(audits).toHaveLength(1);
  });

  it("the bootstrap email becomes an active admin on first sign-in (case-insensitive)", async () => {
    profiles.set("user_boss", { email: "BOSS@Club.test", name: "Boss" });
    const res = await me(await signer.sign({ sub: "user_boss" }));
    expect(await res.json()).toMatchObject({ role: "admin", status: "active" });
    const [row] = await t.db.select().from(member).where(eq(member.clerkUserId, "user_boss"));
    expect(row?.joinedAt?.toISOString()).toBe("2027-01-01T10:00:00.000Z");
  });

  it("re-asserts the bootstrap admin when an existing row was demoted or deactivated", async () => {
    const existing = await makeMember(t.db, { role: "member", status: "inactive" });
    await t.db.update(member).set({ email: BOOTSTRAP }).where(eq(member.id, existing.id));

    const res = await me(await signer.sign({ sub: existing.clerkUserId }));
    expect(await res.json()).toMatchObject({ id: existing.id, role: "admin", status: "active" });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "member.bootstrap_admin"));
    expect(audits).toHaveLength(1);

    // Already admin and active: nothing more to assert, nothing more to audit.
    await me(await signer.sign({ sub: existing.clerkUserId }));
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, "member.bootstrap_admin")),
    ).toHaveLength(1);
  });

  it("never touches an erased member, even with the bootstrap email", async () => {
    const gone = await makeMember(t.db, { role: "member", status: "erased" });
    await t.db.update(member).set({ email: BOOTSTRAP }).where(eq(member.id, gone.id));
    const res = await me(await signer.sign({ sub: gone.clerkUserId }));
    expect(await res.json()).toMatchObject({ role: "member", status: "erased" });
  });

  it("an ordinary member is not promoted, and a missing BOOTSTRAP_ADMIN_EMAIL promotes nobody", async () => {
    profiles.set("user_boss", { email: BOOTSTRAP, name: "Boss" });
    const noBootstrap = { ...env, BOOTSTRAP_ADMIN_EMAIL: "" } as unknown as Cloudflare.Env;
    const res = await routes.request(
      "/me",
      { headers: bearer(await signer.sign({ sub: "user_boss" })) },
      noBootstrap,
    );
    expect(await res.json()).toMatchObject({ role: "member", status: "pending" });
  });
});
