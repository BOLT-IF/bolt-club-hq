import { afterEach, describe, expect, it } from "vitest";

import { FixedClock } from "../core/clock";
import type { Db } from "../core/db/client";
import { realRsvpCancel } from "../rsvp/cancel";
import { FakeRsvpCancel } from "./rsvp-cancel.fake";
import { configureRsvpCancel, getRsvpCancel } from "./rsvp-cancel";

afterEach(() => {
  configureRsvpCancel(undefined);
});

describe("rsvp.cancel port (S2.1 / S4.2)", () => {
  it("production default is realRsvpCancel, never a no-op or recording fake", () => {
    expect(getRsvpCancel()).toBe(realRsvpCancel);
  });

  it("a configured port is used, and reset restores realRsvpCancel", async () => {
    const fake = new FakeRsvpCancel();
    const db = null as unknown as Db;
    const clock = new FixedClock("2027-01-01T00:00:00Z");
    configureRsvpCancel(fake);
    await getRsvpCancel().cancelFutureRsvps({
      db,
      clock,
      memberId: "m1",
      at: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: "k",
    });
    expect(fake.calls).toEqual([
      { db, clock, memberId: "m1", at: new Date("2027-01-01T00:00:00Z"), idempotencyKey: "k" },
    ]);
    configureRsvpCancel(undefined);
    expect(getRsvpCancel()).toBe(realRsvpCancel);
  });
});
