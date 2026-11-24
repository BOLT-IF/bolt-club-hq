import { apiFetch } from "./client";

/** FIFO status of one entry (src/domain/ledger/itemize.ts). */
export type LedgerItemStatus =
  | "unpaid"
  | "partly_paid"
  | "paid"
  | "unapplied"
  | "partly_applied"
  | "applied"
  | "reversed"
  | "reversal";

/** One row of `GET /me/ledger`. Whole kronor; positive = owed, negative = money in. */
export interface LedgerItem {
  readonly id: string;
  readonly kind: "charge" | "payment" | "reversal" | "adjustment";
  readonly reason: string;
  readonly amountSek: number;
  readonly status: LedgerItemStatus;
  readonly allocatedSek: number;
  readonly outstandingSek: number;
  readonly note: string | null;
  readonly createdAt: string;
  readonly reversesEntryId: string | null;
  readonly passId: string | null;
  readonly eventId: string | null;
  readonly eventTitle: string | null;
  readonly eventStartsAt: string | null;
  readonly guestId: string | null;
  readonly guestName: string | null;
}

export interface MyLedger {
  readonly balanceSek: number;
  readonly owedSek: number;
  readonly creditSek: number;
  /** Oldest first. */
  readonly items: readonly LedgerItem[];
}

/** The caller's own ledger. There is deliberately no member id parameter. */
export function fetchMyLedger(signal?: AbortSignal): Promise<MyLedger> {
  return apiFetch<MyLedger>("/me/ledger", signal ? { signal } : {});
}

export interface PublicBank {
  readonly accountHolder?: string;
  readonly iban?: string;
  readonly bankgiro?: string;
}

/** The fields of `GET /settings/public` the money screen uses. */
export interface PaymentSettings {
  readonly bank: PublicBank | null;
  readonly paymentInstructions: string | null;
}

export function fetchPaymentSettings(signal?: AbortSignal): Promise<PaymentSettings> {
  return apiFetch<PaymentSettings>("/settings/public", signal ? { signal } : {});
}

/** The caller's payment reference, from `GET /me/profile`. */
export function fetchMyPaymentRef(signal?: AbortSignal): Promise<string> {
  return apiFetch<{ paymentRef: string }>("/me/profile", signal ? { signal } : {}).then(
    (p) => p.paymentRef,
  );
}
