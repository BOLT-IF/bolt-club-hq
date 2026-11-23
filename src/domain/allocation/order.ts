import type { AllocationMode, Candidate } from "./types";

/**
 * Sort order for candidates (PLAN 6.2).
 *
 * - tiered: (tier, requested_at, id). Guests are tier 3, so they always follow members.
 * - instant: pure first-come (requested_at, id). A guest cannot be confirmed before their
 *   host, so a guest's effective time is the later of their own and their host's request.
 *   Ties go to members before guests, so a host is always placed before their guest.
 *
 * `pool` supplies the candidates that may be a guest's host, so a subset (for example the
 * waitlist alone) sorts the same way it would inside the full roster.
 */
export function sortCandidates(
  mode: AllocationMode,
  items: readonly Candidate[],
  pool: readonly Candidate[] = items,
): Candidate[] {
  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));

  const effectiveTime = (candidate: Candidate): number => {
    if (mode === "tiered" || candidate.kind === "member") return candidate.requestedAt;
    const host = byId.get(candidate.hostId);
    return host ? Math.max(candidate.requestedAt, host.requestedAt) : candidate.requestedAt;
  };

  const kindRank = (candidate: Candidate): number => (candidate.kind === "member" ? 0 : 1);

  return [...items].sort((a, b) => {
    if (mode === "tiered" && a.tier !== b.tier) return a.tier - b.tier;
    const timeDiff = effectiveTime(a) - effectiveTime(b);
    if (timeDiff !== 0) return timeDiff;
    if (kindRank(a) !== kindRank(b)) return kindRank(a) - kindRank(b);
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/** Ids of confirmed members. A guest is eligible only when their host id is in this set. */
export function confirmedHostIds(confirmed: readonly Candidate[]): Set<string> {
  const ids = new Set<string>();
  for (const candidate of confirmed) {
    if (candidate.kind === "member") ids.add(candidate.id);
  }
  return ids;
}

export function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new RangeError(`Capacity must be a non-negative whole number, got ${String(capacity)}`);
  }
}
