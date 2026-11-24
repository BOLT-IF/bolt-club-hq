import { LedgerError } from "./types";

/** The `amount_sek` column is a Postgres `integer`. */
export const MAX_AMOUNT_SEK = 2_147_483_647;

/**
 * Validates a requested amount and returns the signed value to store (PLAN §5.2, AGENTS rule 5).
 * - charge: whole kronor > 0, stored positive.
 * - payment: whole kronor > 0, stored negative.
 * - adjustment: any non-zero whole kronor, the caller's sign is kept.
 * Anything that is not a safe integer within the column range (floats, NaN, strings,
 * bigint, zero) is refused, so no fractional or overflowing money can reach the ledger.
 */
export function entryAmount(kind: "charge" | "payment" | "adjustment", value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LedgerError("invalid_amount", `${kind} amount must be whole kronor`);
  }
  if (value === 0 || Math.abs(value) > MAX_AMOUNT_SEK) {
    throw new LedgerError(
      "invalid_amount",
      `${kind} amount must be between 1 and ${String(MAX_AMOUNT_SEK)} kr`,
    );
  }
  if (kind === "adjustment") return value;
  if (value < 0) {
    throw new LedgerError(
      "invalid_amount",
      `${kind} amount must be positive; the kind sets the sign`,
    );
  }
  return kind === "charge" ? value : -value;
}
