import { apiFetch } from "../../../api/client";

export type StoredAttendance = "unknown" | "attended" | "no_show";
export type MarkableAttendance = "attended" | "no_show";

export interface MemberAttendanceGuest {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly tier: number;
  readonly requestedAt: string;
  readonly refilled: boolean;
  readonly attendance: StoredAttendance;
  readonly effectiveAttendance: MarkableAttendance | null;
}

export interface MemberAttendanceRsvp {
  readonly id: string;
  readonly status: string;
  readonly tier: number;
  readonly requestedAt: string;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly refilled: boolean;
  readonly attendance: StoredAttendance;
  readonly effectiveAttendance: MarkableAttendance | null;
}

export interface MemberAttendanceLedgerEntry {
  readonly id: string;
  readonly kind: "charge" | "payment" | "reversal" | "adjustment";
  readonly reason: string;
  readonly amountSek: number;
  readonly note: string;
  readonly createdAt: string;
  readonly guestId: string | null;
  readonly reversesEntryId: string | null;
}

export interface MemberAttendanceItem {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly location: string | null;
  readonly shareSlug: string;
  readonly eventStatus: "scheduled" | "closed" | "cancelled" | "completed";
  readonly adhocFee: number;
  readonly kind: "series" | "member_oneoff" | "admin_oneoff";
  readonly rsvp: MemberAttendanceRsvp | null;
  readonly guests: readonly MemberAttendanceGuest[];
  readonly ledgerEntries: readonly MemberAttendanceLedgerEntry[];
  readonly netChargedSek: number;
  readonly why: string;
}

export interface MemberAttendanceHistory {
  readonly items: readonly MemberAttendanceItem[];
}

export function fetchMyAttendanceHistory(signal?: AbortSignal): Promise<MemberAttendanceHistory> {
  return apiFetch<MemberAttendanceHistory>("/me/attendance", signal ? { signal } : {});
}
