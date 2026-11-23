import { describe, expect, it } from "vitest";

import { allocate, waitlistInsert } from "./index";
import { guest, ids, member } from "./test-helpers";

describe("waitlistInsert (A5): late RSVPs after close", () => {
  const roster = allocate({
    mode: "tiered",
    capacity: 1,
    candidates: [member("P1", 1, 1), member("N1", 2, 2), guest("GA", "P1", 3)],
  });

  it("starts from the expected post-close roster", () => {
    expect(ids(roster.confirmed)).toEqual(["P1"]);
    expect(ids(roster.waitlist)).toEqual(["N1", "GA"]);
  });

  it.each([
    {
      name: "a late prepaid RSVP goes to the top of the waitlist",
      candidate: member("late-prepaid", 1, 100),
      waitlist: ["late-prepaid", "N1", "GA"],
    },
    {
      name: "a late non-prepaid RSVP queues behind earlier non-prepaid and ahead of guests",
      candidate: member("late-non-prepaid", 2, 50),
      waitlist: ["N1", "late-non-prepaid", "GA"],
    },
    {
      name: "a late guest queues behind everyone else",
      candidate: guest("late-guest", "P1", 200),
      waitlist: ["N1", "GA", "late-guest"],
    },
  ])("$name", ({ candidate, waitlist }) => {
    const result = waitlistInsert(roster, candidate, "tiered");

    expect(ids(result.waitlist)).toEqual(waitlist);
  });

  it("never changes who is confirmed", () => {
    const result = waitlistInsert(roster, member("late-prepaid", 1, 100), "tiered");

    expect(result.confirmed).toEqual(roster.confirmed);
    expect(result.capacity).toBe(roster.capacity);
  });

  it("a late RSVP takes a seat that is still open (open spots go first-come)", () => {
    const withFreeSeat = allocate({
      mode: "tiered",
      capacity: 2,
      candidates: [member("P1", 1, 1), guest("GX", "absent-host", 3)],
    });
    expect(ids(withFreeSeat.confirmed)).toEqual(["P1"]);
    expect(ids(withFreeSeat.waitlist)).toEqual(["GX"]);

    const result = waitlistInsert(withFreeSeat, member("late", 2, 50), "tiered");

    expect(ids(result.confirmed)).toEqual(["P1", "late"]);
    expect(ids(result.waitlist)).toEqual(["GX"]);
  });

  it("instant mode orders the waitlist by request time only", () => {
    const instant = allocate({
      mode: "instant",
      capacity: 0,
      candidates: [member("N1", 2, 2), member("X", 2, 60)],
    });
    const result = waitlistInsert(instant, member("L", 1, 50), "instant");

    expect(ids(result.waitlist)).toEqual(["N1", "L", "X"]);
  });
});
