import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clubSettings } from "../../../../db/schema";
import { FixedClock } from "../../core/clock";
import { createTestDatabase, type TestDatabase } from "../../test-support/database";
import quietHours from "./quiet-hours";

const notification = {
  id: "ntf_1",
  memberId: "m1",
  category: "rsvp_status",
  title: "t",
  body: "b",
  link: null,
};

describe("quiet-hours policy", () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  const evaluate = (iso: string) =>
    quietHours.evaluate({ db: t.db, clock: new FixedClock(iso), notification });

  it("sits in the quiet-hours order slot", () => {
    expect(quietHours.order).toBe(20);
  });

  it("uses the 22:00-08:00 default before club settings are saved", async () => {
    expect(await evaluate("2027-01-15T22:30:00Z")).toEqual({
      action: "defer",
      until: new Date("2027-01-16T07:00:00Z"),
      reason: "quiet hours",
    });
    expect(await evaluate("2027-01-15T12:00:00Z")).toEqual({ action: "allow" });
  });

  it("reads club_settings.quiet_hours", async () => {
    await t.db
      .insert(clubSettings)
      .values({ clubName: "Bolt", quietHours: { start: "20:00", end: "09:30" } });
    expect(await evaluate("2027-01-15T19:30:00Z")).toMatchObject({
      action: "defer",
      until: new Date("2027-01-16T08:30:00Z"),
    });
  });

  it("allows everything when the club has switched quiet hours off (null)", async () => {
    await t.db.insert(clubSettings).values({ clubName: "Bolt", quietHours: null });
    expect(await evaluate("2027-01-15T23:30:00Z")).toEqual({ action: "allow" });
  });
});
