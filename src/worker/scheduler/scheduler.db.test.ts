import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { idempotencyRecord, notification, schedulerState } from "../../../db/schema";
import { FixedClock } from "../core/clock";
import { createTestDatabase, type TestDatabase } from "../test-support/database";
import { makeMember } from "../test-support/factories";
import { alertStaleTick } from "./alert";
import { deleteStaleClaims, STALE_CLAIM_MS } from "./cleanup";
import { recordRun } from "./run";

const NOW = new Date("2026-12-14T12:00:00Z");

describe("scheduler database work", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  describe("stale idempotency claims", () => {
    const claim = (key: string, ageMs: number, extra: Partial<typeof idempotencyRecord.$inferInsert> = {}) =>
      t.db.insert(idempotencyRecord).values({
        key,
        actorId: "m1",
        route: "POST /api/v1/x",
        createdAt: new Date(NOW.getTime() - ageMs),
        ...extra,
      });

    it("deletes empty claims older than the threshold and nothing else", async () => {
      await claim("old-empty", STALE_CLAIM_MS + 60_000);
      await claim("fresh-empty", STALE_CLAIM_MS - 60_000);
      await claim("old-answered", 24 * 3_600_000, { responseBody: "{}", responseStatus: 200 });

      const removed = await deleteStaleClaims(t.db, new FixedClock(NOW));

      expect(removed).toBe(1);
      const left = (await t.db.select().from(idempotencyRecord)).map((r) => r.key).sort();
      expect(left).toEqual(["fresh-empty", "old-answered"]);
    });
  });

  describe("scheduler_state", () => {
    it("records the last run and its error in the singleton row", async () => {
      await recordRun(t.db, { at: NOW, durationMs: 120, error: "boom: failed" });
      await recordRun(t.db, { at: NOW, durationMs: 80, error: null });
      const rows = await t.db.select().from(schedulerState);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, lastTickDurationMs: 80, lastError: null });
      expect(rows[0]?.lastTickAt?.toISOString()).toBe(NOW.toISOString());
    });
  });

  describe("stale tick alert", () => {
    it("notifies every active admin once per outage, in the admin_tasks category", async () => {
      const a = await makeMember(t.db, { role: "admin" });
      const b = await makeMember(t.db, { role: "admin" });
      await makeMember(t.db, { role: "admin", status: "inactive" });
      await makeMember(t.db, { role: "member" });
      const lastTickAt = NOW.getTime() - 3 * 3_600_000;

      await alertStaleTick(t.db, { lastTickAt, now: NOW });
      await alertStaleTick(t.db, { lastTickAt, now: NOW });

      const rows = await t.db.select().from(notification);
      expect(rows.map((r) => r.memberId).sort()).toEqual([a.id, b.id].sort());
      expect(rows.every((r) => r.category === "admin_tasks")).toBe(true);
      expect(await t.db.select().from(notification).where(eq(notification.memberId, a.id))).toHaveLength(1);
    });
  });
});
