/**
 * Ledger domain types (PLAN §5.1). Amounts are whole kronor, signed: a positive entry
 * is money the member owes, a negative one reduces what they owe (payment, waiver,
 * reversal of a charge). Balance = Σ amount, so a positive balance is a debt and a
 * negative balance is credit.
 */
export type LedgerKind = "charge" | "payment" | "reversal" | "adjustment";

export type LedgerReason =
  "pass" | "adhoc" | "guest" | "manual" | "payment" | "waiver" | "revocation" | "opening_balance";

/** The minimal shape the pure functions need. Callers may pass richer rows (see `itemize`). */
export interface LedgerRow {
  id: string;
  kind: LedgerKind;
  /** Signed whole kronor. */
  amountSek: number;
  reason: LedgerReason;
  /** Epoch milliseconds. FIFO order is (createdAt, id). */
  createdAt: number;
  reversesEntryId: string | null;
}

export type LedgerErrorCode =
  | "invalid_amount"
  | "invalid_reason"
  | "note_required"
  | "forbidden"
  | "self_ledger_blocked"
  | "member_not_found"
  | "entry_not_found"
  | "cannot_reverse_reversal"
  | "already_reversed"
  | "idempotency_conflict";

/** A refused ledger operation. `code` is stable and safe to map to an HTTP answer. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
