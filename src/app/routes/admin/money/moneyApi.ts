import { ApiError } from "../../../api/client";
import type { StatusTone } from "../../../components/ui";

export type MemberStatus = "pending" | "active" | "inactive" | "erased";

export interface BalanceRow {
  readonly id: string;
  readonly displayName: string;
  readonly paymentRef: string;
  readonly status: MemberStatus;
  readonly balanceSek: number;
  readonly owedSek: number;
  readonly creditSek: number;
}

export interface AdminPassRow {
  readonly id: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly paymentRef: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly termName: string;
  readonly priceCharged: number;
  readonly eventsCovered: number;
  readonly purchasedAt: string;
  readonly chargeStatus: "unpaid" | "partly_paid" | "paid" | "none";
  readonly unpaidSek: number;
  readonly revocableAt: string;
  readonly daysElapsed: number;
  readonly revocable: boolean;
}

export interface LedgerItem {
  readonly id: string;
  readonly kind: "charge" | "payment" | "reversal" | "adjustment";
  readonly reason: string;
  readonly amountSek: number;
  readonly status: string;
  readonly allocatedSek: number;
  readonly outstandingSek: number;
  readonly note: string;
  readonly createdAt: string;
  readonly reversesEntryId: string | null;
  readonly eventTitle: string | null;
  readonly eventStartsAt: string | null;
  readonly guestName?: string | null;
  readonly waivable: boolean;
  readonly reversible: boolean;
}

export interface MemberLedger {
  readonly member: Pick<BalanceRow, "id" | "displayName" | "paymentRef" | "status">;
  readonly balanceSek: number;
  readonly owedSek: number;
  readonly creditSek: number;
  readonly items: readonly LedgerItem[];
}

/** "Owes 240 kr", "Credit 100 kr" or "Settled". Whole kronor only. */
export function describeBalance(balanceSek: number): string {
  if (balanceSek > 0) return `Owes ${String(balanceSek)} kr`;
  if (balanceSek < 0) return `Credit ${String(-balanceSek)} kr`;
  return "Settled";
}

export function balanceTone(balanceSek: number): StatusTone {
  if (balanceSek > 0) return "warning";
  if (balanceSek < 0) return "info";
  return "success";
}

/** Parses a kronor input. Only whole, positive kronor; anything else is null. */
export function parseKronor(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

export const REASON_LABEL: Record<string, string> = {
  pass: "Pass",
  adhoc: "Drop-in fee",
  guest: "Guest fee",
  manual: "Manual charge",
  payment: "Payment",
  waiver: "Waiver",
  revocation: "Pass revoked",
  opening_balance: "Opening balance",
};

export const STATUS_LABEL: Record<string, { label: string; tone: StatusTone }> = {
  unpaid: { label: "Unpaid", tone: "warning" },
  partly_paid: { label: "Partly paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  unapplied: { label: "Unapplied credit", tone: "info" },
  partly_applied: { label: "Partly applied", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  reversed: { label: "Reversed", tone: "neutral" },
  reversal: { label: "Reversal", tone: "neutral" },
};

const MESSAGES: Record<string, string> = {
  self_ledger_blocked: "This is your own ledger. Another admin must record it.",
  invalid_amount: "Enter whole kronor above 0.",
  note_required: "A reason is required.",
  member_not_found: "That member no longer exists.",
  entry_not_found: "That entry no longer exists. Reload the page.",
  already_reversed: "That entry has already been reversed or waived.",
  cannot_reverse_reversal: "A reversal can't be reversed. Add a charge instead.",
  not_waivable: "Only charges can be waived.",
  pass_not_found: "That pass no longer exists. Reload the page.",
  pass_already_revoked: "That pass has already been revoked.",
  pass_paid: "This pass has been paid and cannot be revoked.",
  revoke_too_early: "This pass cannot be revoked yet.",
  idempotency_key_in_progress: "Still saving the first attempt. Try again in a moment.",
  idempotency_conflict: "This was already saved with different details. Reload the page.",
};

/** Plain-words message for a failed admin money call. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && MESSAGES[code]) return MESSAGES[code];
    if (error.status === 403) return "You don't have permission to do that.";
  }
  return "Couldn't save. Check your connection and try again.";
}
