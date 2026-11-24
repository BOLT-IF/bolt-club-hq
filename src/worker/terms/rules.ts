/** Pure term rules (PLAN §5.1 Term.status, §6.5, A8). No I/O. */

export const TERM_STATUSES = ["draft", "open_for_passes", "active", "closed"] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

/** Forward only: each status has exactly one successor. */
const NEXT: Readonly<Record<TermStatus, TermStatus | null>> = {
  draft: "open_for_passes",
  open_for_passes: "active",
  active: "closed",
  closed: null,
};

export function canTransition(from: TermStatus, to: TermStatus): boolean {
  return NEXT[from] === to;
}

/**
 * A8: the pass cap is the minimum capacity across the series' events. With no events yet
 * it is the series capacity. `eventCapacities` must exclude cancelled events.
 */
export function derivePassCap(seriesCapacity: number, eventCapacities: readonly number[]): number {
  return eventCapacities.length === 0 ? seriesCapacity : Math.min(...eventCapacities);
}
