import { describe, expect, it } from "vitest";

import { claimOffer, promote, type Roster } from "./index";
import { guest, ids, member } from "./test-helpers";

const START = 20_000_000;
const CUTOFF_MIN = 180;
const CUTOFF = START - CUTOFF_MIN * 60_000; // 9_200_000

const P1 = member("P1", 1, 1);
const N1 = member("N1", 2, 2);
const N2 = member("N2", 2, 3);
const GA = guest("GA", "N1", 4);

describe("promote (A6): automatic before the cutoff", () => {
  it("fills freed seats from the top of the waitlist, guests included when their host is confirmed", () => {
    const roster: Roster = { capacity: 3, confirmed: [P1, N1], waitlist: [N2, GA] };

    const result = promote({ roster, now: CUTOFF - 1, startsAt: START, cutoffMinutes: CUTOFF_MIN });

    expect(result.phase).toBe("auto");
    if (result.phase !== "auto") return;
    expect(ids(result.promoted)).toEqual(["N2"]);
    expect(ids(result.roster.confirmed)).toEqual(["P1", "N1", "N2"]);
    expect(ids(result.roster.waitlist)).toEqual(["GA"]);
  });

  it("skips a guest whose host is not confirmed and promotes the next eligible candidate", () => {
    const roster: Roster = {
      capacity: 2,
      confirmed: [P1],
      waitlist: [guest("GX", "X", 1), N2],
    };

    const result = promote({ roster, now: CUTOFF - 1, startsAt: START, cutoffMinutes: CUTOFF_MIN });

    expect(result.phase).toBe("auto");
    if (result.phase !== "auto") return;
    expect(ids(result.roster.confirmed)).toEqual(["P1", "N2"]);
    expect(ids(result.roster.waitlist)).toEqual(["GX"]);
  });
});

describe("promote (A6): offers at and after the cutoff", () => {
  const roster: Roster = { capacity: 3, confirmed: [P1, N1], waitlist: [N2, GA] };

  it("switches to offers exactly at the cutoff, offering the free seat to everyone eligible", () => {
    const result = promote({ roster, now: CUTOFF, startsAt: START, cutoffMinutes: CUTOFF_MIN });

    expect(result.phase).toBe("offer");
    if (result.phase !== "offer") return;
    expect(result.freeSeats).toBe(1);
    expect(ids(result.offeredTo)).toEqual(["N2", "GA"]);
    expect(result.roster).toEqual(roster);
  });

  it("offers nothing when there is no free seat", () => {
    const full: Roster = { capacity: 2, confirmed: [P1, N1], waitlist: [N2] };

    const result = promote({ roster: full, now: CUTOFF + 1, startsAt: START, cutoffMinutes: CUTOFF_MIN });

    expect(result.phase).toBe("offer");
    if (result.phase !== "offer") return;
    expect(result.freeSeats).toBe(0);
    expect(result.offeredTo).toEqual([]);
  });
});

describe("claimOffer (A6): first claim wins", () => {
  const roster: Roster = { capacity: 3, confirmed: [P1, N1], waitlist: [N2, GA] };

  it("the first claimant gets the seat", () => {
    const result = claimOffer({ roster, candidateId: "N2" });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(ids(result.roster.confirmed)).toEqual(["P1", "N1", "N2"]);
    expect(ids(result.roster.waitlist)).toEqual(["GA"]);
  });

  it("a second claimant after the seat is gone is rejected with no_seat", () => {
    const first = claimOffer({ roster, candidateId: "N2" });
    if (first.status !== "claimed") throw new Error("expected first claim to succeed");

    const second = claimOffer({ roster: first.roster, candidateId: "GA" });

    expect(second).toEqual({ status: "rejected", reason: "no_seat" });
  });

  it("someone not on the waitlist is rejected with not_offered", () => {
    expect(claimOffer({ roster, candidateId: "nobody" })).toEqual({
      status: "rejected",
      reason: "not_offered",
    });
  });

  it("a guest whose host is not confirmed is rejected with host_not_confirmed", () => {
    const withGuest: Roster = { capacity: 3, confirmed: [P1], waitlist: [guest("GX", "X", 1)] };

    expect(claimOffer({ roster: withGuest, candidateId: "GX" })).toEqual({
      status: "rejected",
      reason: "host_not_confirmed",
    });
  });
});
