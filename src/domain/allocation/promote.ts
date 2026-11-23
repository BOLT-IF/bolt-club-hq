import { confirmedHostIds, sortCandidates } from "./order";
import { fillFromWaitlist } from "./waitlist";
import type { AllocationMode, Candidate, Roster } from "./types";

export interface PromoteInput {
  readonly mode: AllocationMode;
  readonly roster: Roster;
  /** Current time, epoch milliseconds, injected by the caller (AGENTS.md rule 6). */
  readonly now: number;
  /** Event start, epoch milliseconds. */
  readonly startsAt: number;
  /** Auto-promotion window before start, in minutes (default 180 per PLAN A6). */
  readonly cutoffMinutes: number;
}

export type PromoteResult =
  | { phase: "auto"; roster: Roster; promoted: Candidate[] }
  | { phase: "offer"; roster: Roster; freeSeats: number; offeredTo: Candidate[] };

/**
 * Promotion from the waitlist (PLAN A6).
 *
 * Before the cutoff (startsAt minus cutoffMinutes), free seats are filled automatically in
 * mode order. From the cutoff onward, nothing is filled automatically. Every eligible
 * waitlisted candidate is offered the free seats, and the first to claim one gets it
 * (see claimOffer).
 */
export function promote(input: PromoteInput): PromoteResult {
  const { mode, roster, now, startsAt, cutoffMinutes } = input;
  const cutoffAt = startsAt - cutoffMinutes * 60_000;

  if (now < cutoffAt) {
    const filled = fillFromWaitlist(mode, roster);
    return { phase: "auto", roster: filled.roster, promoted: filled.promoted };
  }

  const freeSeats = Math.max(0, roster.capacity - roster.confirmed.length);
  const hostIds = confirmedHostIds(roster.confirmed);
  const offerable =
    freeSeats === 0
      ? []
      : sortCandidates(mode, roster.waitlist, [...roster.confirmed, ...roster.waitlist]).filter(
          (candidate) => candidate.kind === "member" || hostIds.has(candidate.hostId),
        );

  return { phase: "offer", roster, freeSeats, offeredTo: offerable };
}
