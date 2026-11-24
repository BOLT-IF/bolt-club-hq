import { afterEach, describe, expect, it } from "vitest";

import { FakeRsvpCancel } from "./rsvp-cancel.fake";
import { configureRsvpCancel, getRsvpCancel, noopRsvpCancel } from "./rsvp-cancel";

afterEach(() => {
  configureRsvpCancel(undefined);
});

describe("rsvp.cancel port (stand-in until the RSVP story)", () => {
  it("production default is the no-op, never the recording fake", async () => {
    expect(getRsvpCancel()).toBe(noopRsvpCancel);
    await expect(
      noopRsvpCancel.cancelFutureRsvps({
        memberId: "m1",
        at: new Date("2027-01-01T00:00:00Z"),
        idempotencyKey: "k",
      }),
    ).resolves.toBeUndefined();
  });

  it("a configured port is used, and reset restores the no-op", async () => {
    const fake = new FakeRsvpCancel();
    configureRsvpCancel(fake);
    await getRsvpCancel().cancelFutureRsvps({
      memberId: "m1",
      at: new Date("2027-01-01T00:00:00Z"),
      idempotencyKey: "k",
    });
    expect(fake.calls).toEqual([
      { memberId: "m1", at: new Date("2027-01-01T00:00:00Z"), idempotencyKey: "k" },
    ]);
    configureRsvpCancel(undefined);
    expect(getRsvpCancel()).toBe(noopRsvpCancel);
  });
});
