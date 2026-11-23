import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { allocate, claimOffer, promote, waitlistInsert, type AllocationMode, type Candidate, type Roster } from "./index";
import { member, guest } from "./test-helpers";

/**
 * Property-based tests (fast-check) for the allocation rules in PLAN 6.2.
 * Generated scenarios use unique ids, small integer request times (so ties happen),
 * and guests whose host is sometimes a real candidate and sometimes not.
 */

const RUNS = 300;

const scenarioArb = fc
  .record({
    capacity: fc.integer({ min: 0, max: 12 }),
    members: fc.array(
      fc.record({
        tier: fc.constantFrom(1 as const, 2 as const),
        requestedAt: fc.integer({ min: 0, max: 40 }),
      }),
      { maxLength: 12 },
    ),
    guests: fc.array(
      fc.record({
        hostIndex: fc.nat(20),
        requestedAt: fc.integer({ min: 0, max: 40 }),
      }),
      { maxLength: 12 },
    ),
  })
  .map(({ capacity, members, guests }) => {
    const memberCandidates: Candidate[] = members.map((m, i) => member(`m${i}`, m.tier, m.requestedAt));
    // hostIndex maps onto the members, plus one slot that points at a host who is not a candidate.
    const guestCandidates: Candidate[] = guests.map((g, i) => {
      const slot = g.hostIndex % (members.length + 1);
      const hostId = slot < members.length ? `m${slot}` : "ghost";
      return guest(`g${i}`, hostId, g.requestedAt);
    });
    return { capacity, candidates: [...memberCandidates, ...guestCandidates] };
  });

const scenarioWithOrderArb = scenarioArb.chain(({ capacity, candidates }) =>
  fc.shuffledSubarray(candidates, { minLength: candidates.length, maxLength: candidates.length }).map((shuffled) => ({
    capacity,
    candidates,
    shuffled,
  })),
);

const modeArb = fc.constantFrom<AllocationMode>("tiered", "instant");

function tierOf(c: Candidate): number {
  return c.tier;
}

function compareTiered(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.requestedAt !== b.requestedAt) return a.requestedAt - b.requestedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareInstant(a: Candidate, b: Candidate): number {
  if (a.requestedAt !== b.requestedAt) return a.requestedAt - b.requestedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareFor(mode: AllocationMode): (a: Candidate, b: Candidate) => number {
  return mode === "tiered" ? compareTiered : compareInstant;
}

function confirmedMemberIds(roster: Roster): Set<string> {
  return new Set(roster.confirmed.filter((c) => c.kind === "member").map((c) => c.id));
}

describe("allocation properties", () => {
  it("never over capacity, in either mode", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        const roster = allocate({ mode, capacity, candidates });
        expect(roster.confirmed.length).toBeLessThanOrEqual(capacity);
      }),
      { numRuns: RUNS },
    );
  });

  it("no guest is confirmed without a confirmed host", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        const roster = allocate({ mode, capacity, candidates });
        const hosts = confirmedMemberIds(roster);
        for (const c of roster.confirmed) {
          if (c.kind === "guest") expect(hosts.has(c.hostId)).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a higher tier is never waiting while a lower tier is confirmed at close", () => {
    fc.assert(
      fc.property(scenarioArb, ({ capacity, candidates }) => {
        const roster = allocate({ mode: "tiered", capacity, candidates });
        for (const w of roster.waitlist) {
          for (const c of roster.confirmed) {
            expect(tierOf(w) < tierOf(c)).toBe(false);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("if any member is waiting, every seat is taken", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        const roster = allocate({ mode, capacity, candidates });
        const memberWaiting = roster.waitlist.some((c) => c.kind === "member");
        if (memberWaiting) expect(roster.confirmed.length).toBe(capacity);
      }),
      { numRuns: RUNS },
    );
  });

  it("every candidate is either confirmed or waitlisted, exactly once", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        const roster = allocate({ mode, capacity, candidates });
        const seen = [...roster.confirmed, ...roster.waitlist].map((c) => c.id).sort();
        expect(seen).toEqual(candidates.map((c) => c.id).sort());
      }),
      { numRuns: RUNS },
    );
  });

  it("is deterministic: input order does not change the result", () => {
    fc.assert(
      fc.property(scenarioWithOrderArb, modeArb, ({ capacity, candidates, shuffled }, mode) => {
        const original = allocate({ mode, capacity, candidates });
        const reordered = allocate({ mode, capacity, candidates: shuffled });
        expect(reordered).toEqual(original);
      }),
      { numRuns: RUNS },
    );
  });

  it("the waitlist is kept in mode order", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        const roster = allocate({ mode, capacity, candidates });
        const sorted = [...roster.waitlist].sort(compareFor(mode));
        expect(roster.waitlist).toEqual(sorted);
      }),
      { numRuns: RUNS },
    );
  });

  it("instant mode is pure first-come: with members only, the earliest requests get the seats", () => {
    fc.assert(
      fc.property(scenarioArb, ({ capacity, candidates }) => {
        const members = candidates.filter((c) => c.kind === "member");
        const roster = allocate({ mode: "instant", capacity, candidates: members });
        const expected = [...members].sort(compareInstant).slice(0, capacity);
        expect(roster.confirmed).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it("a late RSVP inserted after close keeps the waitlist sorted and never bumps a confirmed candidate", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        modeArb,
        fc.record({ tier: fc.constantFrom(1 as const, 2 as const), requestedAt: fc.integer({ min: 0, max: 60 }) }),
        ({ capacity, candidates }, mode, late) => {
          const roster = allocate({ mode, capacity, candidates });
          const result = waitlistInsert(roster, member("late", late.tier, late.requestedAt), mode);
          expect(result.confirmed).toEqual(roster.confirmed);
          expect(result.waitlist).toEqual([...result.waitlist].sort(compareFor(mode)));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("auto-promotion before the cutoff fills every free seat it can, and never exceeds capacity", () => {
    const START = 1_000_000_000;
    const CUTOFF_MIN = 180;
    const cutoffAt = START - CUTOFF_MIN * 60_000;
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        // Start from a full-close roster, then free up to two seats to simulate cancellations.
        const closed = allocate({ mode, capacity, candidates });
        const freed = Math.min(2, closed.confirmed.length);
        const roster: Roster = {
          capacity,
          confirmed: closed.confirmed.slice(0, closed.confirmed.length - freed),
          waitlist: closed.waitlist,
        };
        const result = promote({ roster, now: cutoffAt - 1, startsAt: START, cutoffMinutes: CUTOFF_MIN });
        expect(result.phase).toBe("auto");
        if (result.phase !== "auto") return;
        expect(result.roster.confirmed.length).toBeLessThanOrEqual(capacity);
        const hosts = confirmedMemberIds(result.roster);
        for (const c of result.roster.confirmed) {
          if (c.kind === "guest") expect(hosts.has(c.hostId)).toBe(true);
        }
        const eligibleWaiting = result.roster.waitlist.some(
          (c) => c.kind === "member" || hosts.has(c.hostId),
        );
        if (eligibleWaiting) expect(result.roster.confirmed.length).toBe(capacity);
      }),
      { numRuns: RUNS },
    );
  });

  it("claims never exceed capacity, and a candidate can only claim once", () => {
    fc.assert(
      fc.property(scenarioArb, modeArb, ({ capacity, candidates }, mode) => {
        // Everyone is waitlisted with all seats free; claim them one after another.
        let roster: Roster = { capacity, confirmed: [], waitlist: [...candidates].sort(compareFor(mode)) };
        for (const c of candidates) {
          const claim = claimOffer({ roster, candidateId: c.id });
          if (claim.status !== "claimed") continue;
          roster = claim.roster;
          expect(roster.confirmed.length).toBeLessThanOrEqual(capacity);
          const again = claimOffer({ roster, candidateId: c.id });
          expect(again).toEqual({ status: "rejected", reason: "not_offered" });
        }
      }),
      { numRuns: RUNS },
    );
  });
});
