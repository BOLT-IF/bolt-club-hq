/**
 * Allocation types (PLAN 5.1 Rsvp/Guest, 6.1, 6.2). Pure data, no I/O.
 *
 * Tiers: 1 = prepaid member, 2 = non-prepaid member, 3 = guest (always tier 3).
 * Times are epoch milliseconds, supplied by the caller (AGENTS.md rule 6).
 */

export type AllocationMode = "tiered" | "instant";

export interface MemberCandidate {
  readonly kind: "member";
  readonly id: string;
  readonly tier: 1 | 2;
  readonly requestedAt: number;
}

export interface GuestCandidate {
  readonly kind: "guest";
  readonly id: string;
  readonly hostId: string;
  readonly tier: 3;
  readonly requestedAt: number;
}

export type Candidate = MemberCandidate | GuestCandidate;

export interface Roster {
  readonly capacity: number;
  readonly confirmed: readonly Candidate[];
  readonly waitlist: readonly Candidate[];
}
