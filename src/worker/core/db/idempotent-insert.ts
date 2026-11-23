import { ledgerEntry } from "../../../../db/schema";
import type { Db, Tx } from "./client";

export interface IdempotentLedgerInsert {
  memberId: string;
  kind: "charge" | "payment" | "reversal" | "adjustment";
  amountSek: number;
  reason:
    "pass" | "adhoc" | "guest" | "manual" | "payment" | "waiver" | "revocation" | "opening_balance";
  note: string;
  createdBy: string;
  idempotencyKey: string;
  eventId?: string | null;
  passId?: string | null;
  guestId?: string | null;
  paymentClaimId?: string | null;
  reversesEntryId?: string | null;
}

/**
 * Inserts a ledger row at most once per idempotency key. A duplicate key is a
 * no-op (ON CONFLICT DO NOTHING), so concurrent retries settle on one row.
 * Returns true when this call wrote the row.
 */
export async function insertIdempotent(db: Db | Tx, row: IdempotentLedgerInsert): Promise<boolean> {
  const id = `led_${row.idempotencyKey}`;
  const inserted = await db
    .insert(ledgerEntry)
    .values({ ...row, id })
    .onConflictDoNothing({ target: ledgerEntry.idempotencyKey })
    .returning({ id: ledgerEntry.id });
  return inserted.length === 1;
}
