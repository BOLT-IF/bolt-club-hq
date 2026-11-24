import { LedgerError, type LedgerKind } from "./types";

/**
 * The amount of the reversal of `original`, or a refusal. `reversedByIds` are the ids of
 * entries that already reverse it. A reversal is never itself reversed (undo it by
 * charging again), and an entry is reversed at most once.
 */
export function planReversal(
  original: { id: string; kind: LedgerKind; amountSek: number },
  reversedByIds: readonly string[],
): number {
  if (original.kind === "reversal") {
    throw new LedgerError("cannot_reverse_reversal", `entry ${original.id} is a reversal`);
  }
  if (reversedByIds.length > 0) {
    throw new LedgerError("already_reversed", `entry ${original.id} is already reversed`);
  }
  return -original.amountSek;
}
