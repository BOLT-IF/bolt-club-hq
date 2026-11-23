import { describe, expect, it } from "vitest";

import { allocate } from "./index";
import { guest, ids, member } from "./test-helpers";

describe("allocate: tiered worked example (PLAN 6.2)", () => {
  // 16 spots; 10 prepaid members (tier 1), 9 non-prepaid members (tier 2),
  // 2 guests (tier 3) hosted by prepaid members. Input order is deliberately scrambled.
  const prepaid = Array.from({ length: 10 }, (_, i) => member(`P${String(i + 1)}`, 1, 1000 + i));
  const nonPrepaid = Array.from({ length: 9 }, (_, i) => member(`N${String(i + 1)}`, 2, 2000 + i));
  const guestA = guest("GA", "P1", 3000);
  const guestB = guest("GB", "P2", 3001);

  it("confirms all prepaid, then the first 6 non-prepaid by request time, and waitlists the rest in order", () => {
    const roster = allocate({
      mode: "tiered",
      capacity: 16,
      candidates: [guestB, ...nonPrepaid, guestA, ...[...prepaid].reverse()],
    });

    expect(ids(roster.confirmed)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
      "P9",
      "P10",
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
    ]);
    expect(ids(roster.waitlist)).toEqual(["N7", "N8", "N9", "GA", "GB"]);
  });
});

describe("allocate: waitlist order after close (tiered)", () => {
  it.each([
    {
      name: "tier 2 members overflow by request time, not input order",
      capacity: 2,
      candidates: [member("C", 2, 30), member("B", 2, 20), member("A", 2, 10)],
      confirmed: ["A", "B"],
      waitlist: ["C"],
    },
    {
      name: "tier 1 outranks an earlier tier 2 request",
      capacity: 1,
      candidates: [member("early-tier2", 2, 1), member("late-tier1", 1, 99)],
      confirmed: ["late-tier1"],
      waitlist: ["early-tier2"],
    },
    {
      name: "guests rank after every member even if requested earlier",
      capacity: 2,
      candidates: [
        guest("G", "P", 1),
        member("M3", 2, 70),
        member("M2", 2, 60),
        member("M1", 2, 50),
        member("P", 1, 0),
      ],
      confirmed: ["P", "M1"],
      waitlist: ["M2", "M3", "G"],
    },
    {
      name: "a guest of a waitlisted host waits too",
      capacity: 1,
      candidates: [guest("G", "H", 0), member("H", 2, 1), member("P", 1, 5)],
      confirmed: ["P"],
      waitlist: ["H", "G"],
    },
    {
      name: "equal request times break ties by id",
      capacity: 1,
      candidates: [member("b", 2, 10), member("a", 2, 10)],
      confirmed: ["a"],
      waitlist: ["b"],
    },
    {
      name: "a guest of a confirmed host still waits behind a non-guest member",
      capacity: 2,
      candidates: [guest("G", "P1", 1), member("M", 2, 99), member("P1", 1, 0)],
      confirmed: ["P1", "M"],
      waitlist: ["G"],
    },
    {
      name: "a guest whose host is not a candidate is never confirmed, even with free seats",
      capacity: 5,
      candidates: [guest("G", "nobody", 0), member("M", 2, 10)],
      confirmed: ["M"],
      waitlist: ["G"],
    },
  ])("$name", ({ capacity, candidates, confirmed, waitlist }) => {
    const roster = allocate({ mode: "tiered", capacity, candidates });

    expect(ids(roster.confirmed)).toEqual(confirmed);
    expect(ids(roster.waitlist)).toEqual(waitlist);
  });
});

describe("allocate: instant mode is pure first-come", () => {
  it("an earlier tier 2 request beats a later tier 1 request", () => {
    const roster = allocate({
      mode: "instant",
      capacity: 1,
      candidates: [member("late-tier1", 1, 2), member("early-tier2", 2, 1)],
    });

    expect(ids(roster.confirmed)).toEqual(["early-tier2"]);
    expect(ids(roster.waitlist)).toEqual(["late-tier1"]);
  });

  it("the same input under tiered allocation picks the tier 1 request instead", () => {
    const roster = allocate({
      mode: "tiered",
      capacity: 1,
      candidates: [member("late-tier1", 1, 2), member("early-tier2", 2, 1)],
    });

    expect(ids(roster.confirmed)).toEqual(["late-tier1"]);
    expect(ids(roster.waitlist)).toEqual(["early-tier2"]);
  });

  it("guests still need their host confirmed and take seats first-come", () => {
    const roster = allocate({
      mode: "instant",
      capacity: 2,
      candidates: [member("X", 2, 3), guest("G", "M", 2), member("M", 2, 1)],
    });

    expect(ids(roster.confirmed)).toEqual(["M", "G"]);
    expect(ids(roster.waitlist)).toEqual(["X"]);
  });
});
