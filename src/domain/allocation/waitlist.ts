import { confirmedHostIds, sortCandidates } from "./order";
import type { AllocationMode, Candidate, Roster } from "./types";

/**
 * Fills free seats from the waitlist, in mode order. Confirmed candidates are never moved or
 * bumped. A guest is confirmed only when their host is confirmed, including a host confirmed
 * earlier in the same pass.
 */
export function fillFromWaitlist(
  mode: AllocationMode,
  roster: Roster,
): { roster: Roster; promoted: Candidate[] } {
  const pool = [...roster.confirmed, ...roster.waitlist];
  const ordered = sortCandidates(mode, roster.waitlist, pool);
  const hostIds = confirmedHostIds(roster.confirmed);
  const confirmed = [...roster.confirmed];
  const waitlist: Candidate[] = [];
  const promoted: Candidate[] = [];

  for (const candidate of ordered) {
    const eligible = candidate.kind === "member" || hostIds.has(candidate.hostId);
    if (eligible && confirmed.length < roster.capacity) {
      confirmed.push(candidate);
      promoted.push(candidate);
      if (candidate.kind === "member") hostIds.add(candidate.id);
    } else {
      waitlist.push(candidate);
    }
  }

  return { roster: { capacity: roster.capacity, confirmed, waitlist }, promoted };
}

/**
 * Adds a late RSVP after close (PLAN A5). A prepaid member goes to the top of the waitlist
 * but never bumps anyone already confirmed. An open seat goes first-come.
 */
export function waitlistInsert(roster: Roster, candidate: Candidate, mode: AllocationMode): Roster {
  const pool = [...roster.confirmed, ...roster.waitlist, candidate];
  const waitlist = sortCandidates(mode, [...roster.waitlist, candidate], pool);
  return fillFromWaitlist(mode, { ...roster, waitlist }).roster;
}

export type ClaimResult =
  | { status: "claimed"; roster: Roster }
  | { status: "rejected"; reason: "not_offered" | "host_not_confirmed" | "no_seat" };

/**
 * Claims a seat from an offer (PLAN A6). The first claim wins; later claims find no seat.
 */
export function claimOffer(input: { roster: Roster; candidateId: string }): ClaimResult {
  const { roster, candidateId } = input;
  const candidate = roster.waitlist.find((item) => item.id === candidateId);
  if (!candidate) return { status: "rejected", reason: "not_offered" };

  if (candidate.kind === "guest" && !confirmedHostIds(roster.confirmed).has(candidate.hostId)) {
    return { status: "rejected", reason: "host_not_confirmed" };
  }
  if (roster.confirmed.length >= roster.capacity) {
    return { status: "rejected", reason: "no_seat" };
  }

  return {
    status: "claimed",
    roster: {
      capacity: roster.capacity,
      confirmed: [...roster.confirmed, candidate],
      waitlist: roster.waitlist.filter((item) => item.id !== candidateId),
    },
  };
}
