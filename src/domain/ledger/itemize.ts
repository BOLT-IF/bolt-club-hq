import type { LedgerRow } from "./types";

export type ItemStatus =
  /** A charge (or positive adjustment): how much of it is covered. */
  | "unpaid"
  | "partly_paid"
  | "paid"
  /** A payment, waiver or credit entry: how much of it has been used up. */
  | "unapplied"
  | "partly_applied"
  | "applied"
  /** Cancelled by an exact reversal; the pair drops out of the allocation. */
  | "reversed"
  | "reversal";

export interface Item<R extends LedgerRow> {
  entry: R;
  status: ItemStatus;
  /** Kronor of this entry matched against the other side. */
  allocatedSek: number;
  /** Kronor still owed (charge) or still unused as credit (payment). Always >= 0. */
  outstandingSek: number;
}

export interface ItemizeResult<R extends LedgerRow> {
  /** Σ amount. Positive: the member owes. Negative: credit. */
  balanceSek: number;
  owedSek: number;
  creditSek: number;
  /** Every entry, oldest first by (createdAt, id). */
  items: Array<Item<R>>;
}

/** The balance is the sum of the entries (PLAN §5.2 invariant 1). */
export function balanceOf(rows: readonly Pick<LedgerRow, "amountSek">[]): number {
  return rows.reduce((sum, row) => sum + row.amountSek, 0);
}

function byTimeThenId(a: LedgerRow, b: LedgerRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * FIFO allocation (PLAN §9). Money in (payments, waivers, reversals of charges) is matched
 * against money owed (charges, positive adjustments) oldest first, so a partial payment
 * covers the oldest charge and spills into the next, and credit left over is consumed by
 * later charges. Both sides are ordered by (createdAt, id), so the result does not depend
 * on the order the rows are passed in.
 *
 * An entry cancelled by an exact reversal (same member, opposite amount) and its reversal
 * drop out of the allocation entirely: a reversed charge is never "paid", and a reversed
 * payment stops covering charges. A reversal that does not cancel its target exactly is
 * treated as an ordinary entry, so the balance is always the plain sum.
 */
export function itemize<R extends LedgerRow>(rows: readonly R[]): ItemizeResult<R> {
  const sorted = [...rows].sort(byTimeThenId);
  const byId = new Map(sorted.map((row) => [row.id, row]));

  const cancelledBy = new Map<string, string>();
  for (const row of sorted) {
    if (row.kind !== "reversal" || row.reversesEntryId === null) continue;
    const target = byId.get(row.reversesEntryId);
    if (
      target === undefined ||
      target.kind === "reversal" ||
      cancelledBy.has(target.id) ||
      target.amountSek !== -row.amountSek
    ) {
      continue;
    }
    cancelledBy.set(target.id, row.id);
  }
  const cancellingIds = new Set(cancelledBy.values());

  const live = sorted.filter((row) => !cancelledBy.has(row.id) && !cancellingIds.has(row.id));
  const debitTotal = live.reduce((sum, row) => (row.amountSek > 0 ? sum + row.amountSek : sum), 0);
  const creditTotal = live.reduce((sum, row) => (row.amountSek < 0 ? sum - row.amountSek : sum), 0);
  const matched = Math.min(debitTotal, creditTotal);

  let debitLeft = matched;
  let creditLeft = matched;
  const items = sorted.map((entry): Item<R> => {
    if (cancelledBy.has(entry.id)) {
      return { entry, status: "reversed", allocatedSek: 0, outstandingSek: 0 };
    }
    if (cancellingIds.has(entry.id)) {
      return { entry, status: "reversal", allocatedSek: 0, outstandingSek: 0 };
    }
    const size = Math.abs(entry.amountSek);
    if (entry.amountSek > 0) {
      const allocatedSek = Math.min(size, debitLeft);
      debitLeft -= allocatedSek;
      const status = allocatedSek === size ? "paid" : allocatedSek === 0 ? "unpaid" : "partly_paid";
      return { entry, status, allocatedSek, outstandingSek: size - allocatedSek };
    }
    const allocatedSek = Math.min(size, creditLeft);
    creditLeft -= allocatedSek;
    const status =
      allocatedSek === size ? "applied" : allocatedSek === 0 ? "unapplied" : "partly_applied";
    return { entry, status, allocatedSek, outstandingSek: size - allocatedSek };
  });

  const balanceSek = balanceOf(rows);
  return {
    balanceSek,
    owedSek: Math.max(balanceSek, 0),
    creditSek: Math.max(-balanceSek, 0),
    items,
  };
}
