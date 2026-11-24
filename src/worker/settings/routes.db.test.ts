import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { auditLog, clubSettings } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import configRoutes from "../config/routes";
import settingsRoutes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

const IBAN = "SE4550000000058398257466";
const body = {
  clubName: "BOLT IF Badminton",
  bank: { accountHolder: "BOLT IF", iban: IBAN, bankgiro: "5402-9681" },
  paymentInstructions: "Use your payment reference.",
  quietHours: { start: "21:30", end: "07:30" },
  passUnpaidRevokeDays: 14,
  autoPromoteCutoffMin: 120,
  defaults: { capacity: 14, passPrice: 1200, adhocFee: 120 },
  accountCodes: { pass: "3010", adhoc: "3011" },
  rosterAppUrl: "https://roster.example.se/",
};

describe("club settings routes", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-01T10:00:00Z"),
    });
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  const as = (clerkUserId?: string): Record<string, string> =>
    clerkUserId ? { [TEST_IDENTITY_HEADER]: clerkUserId } : {};

  const get = (path: string, who?: string) =>
    settingsRoutes.request(path, { headers: as(who) }, testEnv);

  const put = (payload: unknown, who?: string) =>
    settingsRoutes.request(
      "/admin/settings",
      {
        method: "PUT",
        headers: { ...as(who), "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      testEnv,
    );

  it("is admin only: 401 signed out, 403 for members and pending members", async () => {
    const member = await makeMember(t.db, { role: "member" });
    const pending = await makeMember(t.db, { role: "admin", status: "pending" });

    expect((await get("/admin/settings")).status).toBe(401);
    expect((await get("/admin/settings", member.clerkUserId)).status).toBe(403);
    expect((await get("/admin/settings", pending.clerkUserId)).status).toBe(403);
    expect((await put(body)).status).toBe(401);
    expect((await put(body, member.clerkUserId)).status).toBe(403);
    expect(await t.db.select().from(clubSettings)).toEqual([]);
  });

  it("returns the defaults before anything is saved", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await get("/admin/settings", admin.clerkUserId);
    expect(res.status).toBe(200);
    const settings = await res.json<Record<string, unknown>>();
    expect(settings).toMatchObject({
      passUnpaidRevokeDays: 21,
      autoPromoteCutoffMin: 180,
      quietHours: { start: "22:00", end: "08:00" },
      bank: null,
      rosterAppUrl: null,
    });
  });

  it("saves normalised settings, serves them back and audits the change", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await put(body, admin.clerkUserId);
    expect(res.status).toBe(200);

    const saved = await (
      await get("/admin/settings", admin.clerkUserId)
    ).json<typeof body & { rosterAppUrl: string }>();
    expect(saved).toMatchObject({
      clubName: "BOLT IF Badminton",
      passUnpaidRevokeDays: 14,
      autoPromoteCutoffMin: 120,
      rosterAppUrl: "https://roster.example.se",
      accountCodes: { pass: "3010", adhoc: "3011" },
      defaults: { capacity: 14, passPrice: 1200, adhocFee: 120 },
    });

    // A second save updates the singleton row, it never adds one.
    expect((await put({ ...body, clubName: "Renamed" }, admin.clerkUserId)).status).toBe(200);
    const rows = await t.db.select().from(clubSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.clubName).toBe("Renamed");

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.entity, "club_settings"));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorId: admin.id,
      action: "settings.update",
      entityId: "1",
    });
    expect(audits[0]?.at.toISOString()).toBe("2027-01-01T10:00:00.000Z");
    expect(audits[1]?.before).toContain("BOLT IF Badminton");
  });

  it.each([
    ["IBAN", { bank: { iban: "SE4550000000058398257467" } }, "bank.iban"],
    ["bankgiro", { bank: { bankgiro: "5402-9682" } }, "bank.bankgiro"],
    ["roster URL", { rosterAppUrl: "javascript:alert(1)" }, "rosterAppUrl"],
    ["http roster URL", { rosterAppUrl: "http://roster.example.se" }, "rosterAppUrl"],
    ["revoke days", { passUnpaidRevokeDays: 0 }, "passUnpaidRevokeDays"],
  ])("rejects an invalid %s with 400 and saves nothing", async (_name, patch, field) => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await put({ ...body, ...patch }, admin.clerkUserId);
    expect(res.status).toBe(400);
    const error = await res.json<{ error: string; fields: Record<string, string> }>();
    expect(error.error).toBe("validation");
    expect(Object.keys(error.fields)).toContain(field);
    expect(await t.db.select().from(clubSettings)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const res = await settingsRoutes.request(
      "/admin/settings",
      {
        method: "PUT",
        headers: { ...as(admin.clerkUserId), "content-type": "application/json" },
        body: "{nope",
      },
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("serves the public subset to active and inactive members, never pending or the private fields", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    const member = await makeMember(t.db, { role: "member" });
    const inactive = await makeMember(t.db, { status: "inactive" });
    const pending = await makeMember(t.db, { status: "pending" });
    await put(body, admin.clerkUserId);

    expect((await get("/settings/public")).status).toBe(401);
    expect((await get("/settings/public", pending.clerkUserId)).status).toBe(403);
    expect((await get("/settings/public", inactive.clerkUserId)).status).toBe(200);

    const res = await get("/settings/public", member.clerkUserId);
    expect(res.status).toBe(200);
    const pub = await res.json<Record<string, unknown>>();
    expect(Object.keys(pub).sort()).toEqual(
      ["bank", "clubName", "paymentInstructions", "quietHours", "rosterAppUrl"].sort(),
    );
    expect(pub).toMatchObject({
      clubName: "BOLT IF Badminton",
      bank: { iban: IBAN, bankgiro: "5402-9681" },
      rosterAppUrl: "https://roster.example.se",
    });
    const text = JSON.stringify(pub);
    for (const secret of [
      "3010",
      "accountCodes",
      "passUnpaidRevokeDays",
      "autoPromoteCutoffMin",
      "defaults",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("/config stays anonymous and never leaks settings, bank details included", async () => {
    const admin = await makeMember(t.db, { role: "admin" });
    await put(body, admin.clerkUserId);

    const res = await configRoutes.request("/config", {}, testEnv);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    for (const secret of [IBAN, "5402-9681", "3010", "BOLT IF", "passUnpaidRevokeDays"]) {
      expect(text).not.toContain(secret);
    }
  });
});
