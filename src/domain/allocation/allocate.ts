import { assertCapacity, sortCandidates } from "./order";
import type { AllocationMode, Candidate, Roster } from "./types";

export interface AllocateInput {
  readonly mode: AllocationMode;
  readonly capacity: number;
  readonly candidates: readonly Candidate[];
}

/**
 * Close-time allocation (PLAN 6.2). Walks candidates in mode order and confirms each one
 * who fits. A guest is confirmed only when their host is confirmed. Anyone who does not
 * fit goes to the waitlist, in the same order.
 *
 * Tiered mode processes all members before guests, so a host's status is final before
 * their guest is considered. Instant mode sorts a guest after their host (see order.ts).
 */
export function allocate(input: AllocateInput): Roster {
  const { mode, capacity, candidates } = input;
  assertCapacity(capacity);

  const ordered = sortCandidates(mode, candidates);
  const confirmed: Candidate[] = [];
  const waitlist: Candidate[] = [];
  const hostIds = new Set<string>();

  for (const candidate of ordered) {
    const eligible = candidate.kind === "member" || hostIds.has(candidate.hostId);
    if (eligible && confirmed.length < capacity) {
      confirmed.push(candidate);
      if (candidate.kind === "member") hostIds.add(candidate.id);
    } else {
      waitlist.push(candidate);
    }
  }

  return { capacity, confirmed, waitlist };
}
