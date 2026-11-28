/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- response bodies are asserted field by field; typing every shape adds nothing. */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditLog, event, member, pass, series, seriesCaptain, term } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { configureRequestDeps } from "../core/context";
import { TEST_IDENTITY_HEADER } from "../core/test-identity";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import routes from "./routes";

const testEnv = { ENV: "test" } as unknown as Cloudflare.Env;

type Member = Awaited<ReturnType<typeof makeMember>>;

const seriesBody = {
  termId: "t1",
  name: "Thursday XD",
  format: "Mixed Doubles",
  weekday: 4,
  startTime: "19:00",
  durationMin: 90,
  capacity: 16,
  passPrice: 1800,
  adhocFee: 120,
};

describe("terms, series, captains, clone (S3.1)", () => {
  let t: TestDatabase;
  let admin: Member;
  let captain: Member;
  let plain: Member;

  beforeEach(async () => {
    t = await createTestDatabase();
    configureRequestDeps({
      db: () => Promise.resolve(t.db),
      clock: new FixedClock("2027-01-04T09:00:00Z"),
    });
    admin = await makeMember(t.db, { role: "admin" });
    captain = await makeMember(t.db);
    plain = await makeMember(t.db);
  });

  afterEach(async () => {
    configureRequestDeps({});
    await t.close();
  });

  async function call(
    as: Member | null,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (as) headers[TEST_IDENTITY_HEADER] = as.clerkUserId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await routes.request(path, init, testEnv);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, res };
  }

  async function seedTerm(
    id = "t1",
    status: "draft" | "open_for_passes" | "active" | "closed" = "draft",
  ) {
    await t.db
      .insert(term)
      .values({ id, name: `Term ${id}`, startsOn: "2027-01-11", endsOn: "2027-06-24", status });
  }

  async function seedSeries(
    id: string,
    termId = "t1",
    overrides: Partial<typeof series.$inferInsert> = {},
  ) {
    await t.db.insert(series).values({
      id,
      termId,
      name: `Series ${id}`,
      format: "Mixed Doubles",
      weekday: 4,
      startTime: "19:00",
      durationMin: 90,
      capacity: 16,
      passPrice: 1800,
      adhocFee: 120,
      shareSlug: `slug-${id}-abcdefgh`,
      passCap: 16,
      ...overrides,
    });
  }

  async function seedEvent(
    seriesId: string,
    id: string,
    capacity: number,
    status: "scheduled" | "cancelled" = "scheduled",
  ) {
    await t.db.insert(event).values({
      id,
      seriesId,
      kind: "series",
      createdBy: admin.id,
      title: id,
      format: "Mixed Doubles",
      startsAt: new Date("2027-02-04T18:00:00Z"),
      endsAt: new Date("2027-02-04T19:30:00Z"),
      capacity,
      adhocFee: 120,
      rsvpCloseAt: new Date("2027-02-03T18:00:00Z"),
      allocationMode: "tiered",
      status,
      shareSlug: `ev-${id}-abcdefgh`,
    });
  }

  async function seedPass(seriesId: string, id: string) {
    const buyer = await makeMember(t.db);
    await t.db.insert(pass).values({
      id,
      memberId: buyer.id,
      seriesId,
      priceCharged: 1800,
      eventsCovered: 20,
    });
  }

  describe("permissions", () => {
    it("signed-out is 401, a plain member is 403, an admin passes", async () => {
      expect((await call(null, "GET", "/terms")).status).toBe(401);
      expect((await call(plain, "GET", "/terms")).status).toBe(403);
      expect((await call(plain, "POST", "/terms", {})).status).toBe(403);
      expect((await call(admin, "GET", "/terms")).status).toBe(200);
    });
  });

  describe("terms and the status machine", () => {
    it("creates a draft term and audits it", async () => {
      const res = await call(admin, "POST", "/terms", {
        name: "Spring 2027",
        startsOn: "2027-01-11",
        endsOn: "2027-06-24",
      });
      expect(res.status).toBe(201);
      expect(res.body.term).toMatchObject({
        name: "Spring 2027",
        season: "spring",
        clubYear: 2026,
        status: "draft",
        clonedFromTermId: null,
      });
      const rows = await t.db.select().from(auditLog).where(eq(auditLog.entity, "term"));
      expect(rows.map((r) => r.action)).toEqual(["term.create"]);
      expect(rows[0]?.actorId).toBe(admin.id);
    });

    it("rejects bad input with 422", async () => {
      const res = await call(admin, "POST", "/terms", {
        name: "x",
        startsOn: "2027-06-24",
        endsOn: "2027-01-11",
      });
      expect(res.status).toBe(422);
    });

    it("walks draft → open_for_passes → active → closed", async () => {
      await seedTerm();
      for (const status of ["open_for_passes", "active", "closed"]) {
        const res = await call(admin, "PATCH", "/terms/t1", { status });
        expect(res.status).toBe(200);
        expect(res.body.term.status).toBe(status);
      }
    });

    it.each([
      ["draft", "active"],
      ["draft", "closed"],
      ["open_for_passes", "draft"],
      ["open_for_passes", "closed"],
      ["active", "open_for_passes"],
      ["closed", "active"],
      ["draft", "draft"],
    ] as const)("rejects %s → %s with 409 and changes nothing", async (from, to) => {
      await seedTerm("t1", from);
      const res = await call(admin, "PATCH", "/terms/t1", { status: to });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("invalid_transition");
      const [row] = await t.db.select().from(term).where(eq(term.id, "t1"));
      expect(row?.status).toBe(from);
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.entity, "term"));
      expect(audits).toHaveLength(0);
    });

    it("opening for passes locks skip-dates on every series of the term, not other terms", async () => {
      await seedTerm("t1");
      await seedTerm("t2");
      await seedSeries("s1", "t1");
      await seedSeries("s2", "t1");
      await seedSeries("s3", "t2");
      await call(admin, "PATCH", "/terms/t1", { status: "open_for_passes" });
      const rows = await t.db.select().from(series);
      const locked = Object.fromEntries(rows.map((r) => [r.id, r.skipDatesLocked]));
      expect(locked).toEqual({ s1: true, s2: true, s3: false });
    });

    it("dates can change only while the term is a draft; the name always can", async () => {
      await seedTerm("t1", "open_for_passes");
      expect((await call(admin, "PATCH", "/terms/t1", { endsOn: "2027-07-01" })).status).toBe(409);
      expect((await call(admin, "PATCH", "/terms/t1", { name: "Renamed" })).status).toBe(200);
    });

    it("lists terms with their series count; unknown id is 404", async () => {
      await seedTerm("t1");
      await seedSeries("s1");
      const list = await call(admin, "GET", "/terms");
      expect(list.body.terms).toEqual([expect.objectContaining({ id: "t1", seriesCount: 1 })]);
      expect((await call(admin, "GET", "/terms/nope")).status).toBe(404);
    });

    it("deletes an empty draft term, but not one with series or one past draft", async () => {
      await seedTerm("t1");
      await seedSeries("s1");
      await seedTerm("t2", "active");
      await seedTerm("t3");
      expect((await call(admin, "DELETE", "/terms/t1")).status).toBe(409);
      expect((await call(admin, "DELETE", "/terms/t2")).status).toBe(409);
      expect((await call(admin, "DELETE", "/terms/t3")).status).toBe(204);
    });

    it("supports explicit season/clubYear on create, patch, and clone (auto-inferring when omitted)", async () => {
      const created = await call(admin, "POST", "/terms", {
        name: "Fall 2026",
        startsOn: "2026-08-25",
        endsOn: "2026-12-15",
      });
      expect(created.status).toBe(201);
      expect(created.body.term).toMatchObject({ season: "fall", clubYear: 2026 });

      const patched = await call(admin, "PATCH", `/terms/${String(created.body.term.id)}`, {
        season: "spring",
        clubYear: 2025,
      });
      expect(patched.status).toBe(200);
      expect(patched.body.term).toMatchObject({ season: "spring", clubYear: 2025 });

      const cloned = await call(
        admin,
        "POST",
        `/terms/${String(created.body.term.id)}/clone`,
        { startsOn: "2027-01-11", endsOn: "2027-06-24" },
        { "Idempotency-Key": "clone-season-1" },
      );
      expect(cloned.status).toBe(201);
      expect(cloned.body.term).toMatchObject({ season: "spring", clubYear: 2026 });
    });
  });

  describe("series CRUD and pass_cap", () => {
    it("creates a series with a random slug, defaults and pass_cap = capacity", async () => {
      await seedTerm();
      const res = await call(admin, "POST", "/series", seriesBody);
      expect(res.status).toBe(201);
      const s = res.body.series;
      expect(s.shareSlug).toMatch(/^[a-z0-9]{8,}$/);
      expect(s).toMatchObject({
        passCap: 16,
        maxGuestsDefault: 1,
        rsvpCloseOffsetMin: 1440,
        skipDates: [],
        skipDatesLocked: false,
        captains: [],
      });
      const other = await call(admin, "POST", "/series", seriesBody);
      expect(other.body.series.shareSlug).not.toBe(s.shareSlug);
    });

    it("a series added after sales open starts with skip-dates locked", async () => {
      await seedTerm("t1", "open_for_passes");
      const res = await call(admin, "POST", "/series", seriesBody);
      expect(res.body.series.skipDatesLocked).toBe(true);
    });

    it("rejects an unknown term (404) and a closed term (409)", async () => {
      expect((await call(admin, "POST", "/series", seriesBody)).status).toBe(404);
      await seedTerm("t1", "closed");
      expect((await call(admin, "POST", "/series", seriesBody)).status).toBe(409);
    });

    it("pass_cap is the minimum capacity across non-cancelled events (A8)", async () => {
      await seedTerm();
      await seedSeries("s1");
      await seedEvent("s1", "e1", 14);
      await seedEvent("s1", "e2", 9);
      await seedEvent("s1", "e3", 5, "cancelled");
      const res = await call(admin, "PATCH", "/series/s1", { name: "Renamed" });
      expect(res.body.series.passCap).toBe(9);
    });

    it("lowering capacity lowers pass_cap while there are no events", async () => {
      await seedTerm();
      await seedSeries("s1");
      const res = await call(admin, "PATCH", "/series/s1", { capacity: 10 });
      expect(res.status).toBe(200);
      expect(res.body.series).toMatchObject({ capacity: 10, passCap: 10 });
    });

    it("blocks a capacity that puts the cap below passes sold unless overridden", async () => {
      await seedTerm();
      await seedSeries("s1");
      for (const id of ["p1", "p2", "p3"]) await seedPass("s1", id);

      const blocked = await call(admin, "PATCH", "/series/s1", { capacity: 2 });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({
        error: "cap_below_passes_sold",
        passCap: 2,
        passesSold: 3,
      });
      const [unchanged] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(unchanged?.capacity).toBe(16);

      const forced = await call(admin, "PATCH", "/series/s1", {
        capacity: 2,
        overrideCapBelowSold: true,
      });
      expect(forced.status).toBe(200);
      expect(forced.body.series.passCap).toBe(2);
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, "series.update"));
      expect(audits.some((a) => (a.after ?? "").includes("overrideCapBelowSold"))).toBe(true);
    });

    it("revoked passes do not count as sold", async () => {
      await seedTerm();
      await seedSeries("s1");
      await seedPass("s1", "p1");
      await t.db.update(pass).set({ status: "revoked" }).where(eq(pass.id, "p1"));
      expect((await call(admin, "PATCH", "/series/s1", { capacity: 1 })).status).toBe(200);
    });

    it("cannot edit a series of a closed term", async () => {
      await seedTerm("t1", "closed");
      await seedSeries("s1");
      expect((await call(admin, "PATCH", "/series/s1", { name: "x" })).status).toBe(409);
    });

    it("deletes a series with no events or passes, not one with either", async () => {
      await seedTerm();
      await seedSeries("s1");
      await seedSeries("s2");
      await seedSeries("s3");
      await seedEvent("s2", "e1", 10);
      await seedPass("s3", "p1");
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      expect((await call(admin, "DELETE", "/series/s1")).status).toBe(204);
      expect((await call(admin, "DELETE", "/series/s2")).status).toBe(409);
      expect((await call(admin, "DELETE", "/series/s3")).status).toBe(409);
      expect(await t.db.select().from(seriesCaptain)).toHaveLength(0);
    });
  });

  describe("captains", () => {
    beforeEach(async () => {
      await seedTerm();
      await seedSeries("s1");
      await seedSeries("s2");
    });

    it("an admin sets the captains of a series; the set is replaced, not appended", async () => {
      const first = await call(admin, "PUT", "/series/s1/captains", {
        memberIds: [captain.id, plain.id],
      });
      expect(first.status).toBe(200);
      expect(first.body.series.captains.map((c: { id: string }) => c.id).sort()).toEqual(
        [captain.id, plain.id].sort(),
      );
      const second = await call(admin, "PUT", "/series/s1/captains", { memberIds: [plain.id] });
      expect(second.body.series.captains.map((c: { id: string }) => c.id)).toEqual([plain.id]);
      expect(
        await t.db.select().from(seriesCaptain).where(eq(seriesCaptain.seriesId, "s2")),
      ).toHaveLength(0);
    });

    it("only active members can be captains (422), and nothing changes on failure", async () => {
      const pending = await makeMember(t.db, { status: "pending" });
      const res = await call(admin, "PUT", "/series/s1/captains", {
        memberIds: [captain.id, pending.id],
      });
      expect(res.status).toBe(422);
      expect(await t.db.select().from(seriesCaptain)).toHaveLength(0);
      expect(
        (await call(admin, "PUT", "/series/s1/captains", { memberIds: ["ghost"] })).status,
      ).toBe(422);
    });

    it("a captain cannot set captains, not even for their own series", async () => {
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      const res = await call(captain, "PUT", "/series/s1/captains", { memberIds: [plain.id] });
      expect(res.status).toBe(403);
    });

    it("captain permissions apply only to their own series", async () => {
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      expect((await call(captain, "GET", "/series/s1")).status).toBe(200);
      expect((await call(captain, "GET", "/series/s2")).status).toBe(403);
      expect((await call(captain, "PATCH", "/series/s1", { location: "Hall B" })).status).toBe(200);
      expect((await call(captain, "PATCH", "/series/s2", { location: "Hall B" })).status).toBe(403);
      const [other] = await t.db.select().from(series).where(eq(series.id, "s2"));
      expect(other?.location).toBeNull();
    });

    it("a captain may change operational fields only, never money or capacity", async () => {
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      const ok = await call(captain, "PATCH", "/series/s1", {
        location: "Hall B",
        maxGuestsDefault: 2,
        rsvpCloseOffsetMin: 720,
      });
      expect(ok.status).toBe(200);
      for (const patch of [
        { capacity: 30 },
        { passPrice: 1 },
        { adhocFee: 0 },
        { name: "Mine" },
        { overrideCapBelowSold: true },
      ]) {
        const res = await call(captain, "PATCH", "/series/s1", patch);
        expect(res.status, JSON.stringify(patch)).toBe(403);
        expect(res.body.error).toBe("forbidden_field");
      }
      const [row] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(row).toMatchObject({
        capacity: 16,
        passPrice: 1800,
        name: "Series s1",
        location: "Hall B",
      });
    });

    it("a captain cannot create or delete series, or touch terms", async () => {
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      expect((await call(captain, "POST", "/series", seriesBody)).status).toBe(403);
      expect((await call(captain, "DELETE", "/series/s1")).status).toBe(403);
      expect((await call(captain, "GET", "/terms")).status).toBe(403);
      expect((await call(captain, "PATCH", "/terms/t1", { name: "x" })).status).toBe(403);
    });

    it("GET /series lists everything for an admin and only captained series for a captain", async () => {
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
      const ids = (r: { body: { series: Array<{ id: string }> } }) =>
        r.body.series.map((s) => s.id).sort();
      expect(ids(await call(admin, "GET", "/series"))).toEqual(["s1", "s2"]);
      expect(ids(await call(captain, "GET", "/series"))).toEqual(["s1"]);
      expect(ids(await call(plain, "GET", "/series"))).toEqual([]);
    });

    it("lists the active members an admin can pick as captains", async () => {
      await makeMember(t.db, { status: "pending", displayName: "Pending Pat" });
      const res = await call(admin, "GET", "/series/captain-candidates");
      expect(res.status).toBe(200);
      const names = res.body.members.map((m: { displayName: string }) => m.displayName);
      expect(names).not.toContain("Pending Pat");
      expect(res.body.members).toHaveLength(3);
      expect((await call(captain, "GET", "/series/captain-candidates")).status).toBe(403);
    });
  });

  describe("clone term", () => {
    const cloneBody = { name: "Autumn 2027", startsOn: "2027-07-05", endsOn: "2027-12-20" };

    async function seedSource() {
      await seedTerm("t1", "active");
      await seedSeries("s1", "t1", {
        skipDates: ["2027-02-18"],
        skipDatesLocked: true,
        location: "Hall A",
        passCap: 9,
        level: "intermediate",
        discountedPassPrice: 1400,
      });
      await seedSeries("s2", "t1");
      await seedEvent("s1", "e1", 9);
      await seedPass("s1", "p1");
      await t.db.insert(seriesCaptain).values({ seriesId: "s1", memberId: captain.id });
    }

    it("copies the series into a new draft term, without events, passes or skip-dates", async () => {
      await seedSource();
      const res = await call(admin, "POST", "/terms/t1/clone", cloneBody, {
        "Idempotency-Key": "k1",
      });
      expect(res.status).toBe(201);
      expect(res.body.term).toMatchObject({
        name: "Autumn 2027",
        status: "draft",
        startsOn: "2027-07-05",
        endsOn: "2027-12-20",
        clonedFromTermId: "t1",
      });
      expect(res.body.series).toHaveLength(2);

      const copied = await t.db.select().from(series).where(eq(series.termId, res.body.term.id));
      expect(copied).toHaveLength(2);
      const copyOfS1 = copied.find((s) => s.name === "Series s1");
      expect(copyOfS1).toMatchObject({
        format: "Mixed Doubles",
        weekday: 4,
        startTime: "19:00",
        durationMin: 90,
        location: "Hall A",
        level: "intermediate",
        capacity: 16,
        passPrice: 1800,
        discountedPassPrice: 1400,
        adhocFee: 120,
        skipDates: [],
        skipDatesLocked: false,
        passCap: 16,
      });
      expect(copyOfS1?.id).not.toBe("s1");
      expect(copyOfS1?.shareSlug).not.toBe("slug-s1-abcdefgh");
      expect(new Set(copied.map((s) => s.shareSlug)).size).toBe(2);

      // Nothing hangs off the new series.
      const newIds = copied.map((s) => s.id);
      const events = await t.db.select().from(event);
      const passes = await t.db.select().from(pass);
      expect(events.filter((e) => e.seriesId && newIds.includes(e.seriesId))).toHaveLength(0);
      expect(passes.filter((p) => newIds.includes(p.seriesId))).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(passes).toHaveLength(1);
    });

    it("leaves the source term and its series untouched and does not copy captains", async () => {
      await seedSource();
      await call(admin, "POST", "/terms/t1/clone", cloneBody, { "Idempotency-Key": "k1" });
      const [source] = await t.db.select().from(term).where(eq(term.id, "t1"));
      expect(source?.status).toBe("active");
      const [s1] = await t.db.select().from(series).where(eq(series.id, "s1"));
      expect(s1).toMatchObject({ skipDatesLocked: true, passCap: 9 });
      expect(s1?.skipDates).toEqual(["2027-02-18"]);
      const captains = await t.db.select().from(seriesCaptain);
      expect(captains).toEqual([{ seriesId: "s1", memberId: captain.id }]);
    });

    it("defaults the name to 'Copy of <source>' when none is given", async () => {
      await seedSource();
      const res = await call(
        admin,
        "POST",
        "/terms/t1/clone",
        { startsOn: "2027-07-05", endsOn: "2027-12-20" },
        { "Idempotency-Key": "k1" },
      );
      expect(res.body.term.name).toBe("Copy of Term t1");
    });

    it("a replayed Idempotency-Key makes one clone; a missing key is 400", async () => {
      await seedSource();
      const first = await call(admin, "POST", "/terms/t1/clone", cloneBody, {
        "Idempotency-Key": "k1",
      });
      const again = await call(admin, "POST", "/terms/t1/clone", cloneBody, {
        "Idempotency-Key": "k1",
      });
      expect(again.status).toBe(201);
      expect(again.body.term.id).toBe(first.body.term.id);
      expect(await t.db.select().from(term)).toHaveLength(2);
      expect((await call(admin, "POST", "/terms/t1/clone", cloneBody)).status).toBe(400);
    });

    it("404 for an unknown source, 403 for a member, 422 for bad dates", async () => {
      await seedSource();
      expect(
        (await call(admin, "POST", "/terms/nope/clone", cloneBody, { "Idempotency-Key": "a" }))
          .status,
      ).toBe(404);
      expect(
        (await call(plain, "POST", "/terms/t1/clone", cloneBody, { "Idempotency-Key": "b" }))
          .status,
      ).toBe(403);
      expect(
        (await call(admin, "POST", "/terms/t1/clone", { name: "x" }, { "Idempotency-Key": "c" }))
          .status,
      ).toBe(422);
      expect(
        await t.db
          .select()
          .from(term)
          .where(and(eq(term.clonedFromTermId, "t1"))),
      ).toHaveLength(0);
    });

    it("audits the clone", async () => {
      await seedSource();
      await call(admin, "POST", "/terms/t1/clone", cloneBody, { "Idempotency-Key": "k1" });
      const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "term.clone"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entityId).not.toBe("t1");
    });
  });

  it("uses the injected clock for audit timestamps", async () => {
    await call(admin, "POST", "/terms", {
      name: "A",
      startsOn: "2027-01-11",
      endsOn: "2027-06-24",
    });
    const [row] = await t.db.select().from(auditLog);
    expect(row?.at.toISOString()).toBe("2027-01-04T09:00:00.000Z");
    expect((await t.db.select().from(member)).length).toBeGreaterThan(0);
  });

  describe("discounted pass rate", () => {
    it("creates a series with discountedPassPrice and discountEligibleIds, and updates eligibility", async () => {
      const m1 = await makeMember(t.db, { displayName: "Returning Ada" });
      const m2 = await makeMember(t.db, { displayName: "New Bo" });
      await call(admin, "POST", "/terms", {
        name: "Spring",
        startsOn: "2027-01-11",
        endsOn: "2027-06-24",
      });
      const termsRes = await call(admin, "GET", "/terms");
      const { terms } = termsRes.body as { terms: Array<{ id: string }> };
      const termId = terms[0]!.id;

      const tooHigh = await call(admin, "POST", "/series", {
        termId,
        name: "Sunday",
        format: "Open",
        weekday: 7,
        startTime: "18:00",
        durationMin: 120,
        capacity: 16,
        passPrice: 1000,
        discountedPassPrice: 1100,
        adhocFee: 100,
      });
      expect(tooHigh.status).toBe(422);

      const created = await call(admin, "POST", "/series", {
        termId,
        name: "Sunday",
        format: "Open",
        weekday: 7,
        startTime: "18:00",
        durationMin: 120,
        capacity: 16,
        passPrice: 1000,
        discountedPassPrice: 750,
        adhocFee: 100,
        discountEligibleIds: [m1.id],
      });
      expect(created.status).toBe(201);
      const { series: s } = created.body as {
        series: {
          id: string;
          discountedPassPrice: number | null;
          discountEligible: Array<{ id: string }>;
        };
      };
      expect(s.discountedPassPrice).toBe(750);
      expect(s.discountEligible.map((m) => m.id)).toEqual([m1.id]);

      const updated = await call(admin, "PUT", `/series/${s.id}/discount-eligible`, {
        memberIds: [m2.id],
      });
      expect(updated.status).toBe(200);
      const body = updated.body as {
        series: { discountEligible: Array<{ id: string }> };
      };
      expect(body.series.discountEligible.map((m) => m.id)).toEqual([m2.id]);
    });
  });
});
