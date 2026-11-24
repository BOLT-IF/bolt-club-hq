import { ApiError } from "../../api/client";

export interface MemberRow {
  readonly id: string;
  readonly displayName: string;
  readonly rosterName: string | null;
  readonly email: string | null;
  readonly role: "member" | "admin";
  readonly status: "pending" | "active" | "inactive" | "erased";
  readonly paymentRef: string;
}

const MESSAGES: Record<string, string> = {
  last_admin: "That is the last admin. Make someone else an admin first.",
  payment_ref_taken: "That payment reference is already used by another member.",
  invalid_payment_ref: "Use 3 to 40 letters, digits or dashes.",
  invalid_transition: "This member can't be switched between active and inactive.",
  not_found: "That member no longer exists.",
};

/** Plain-words message for a failed members call. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (typeof code === "string" && MESSAGES[code]) return MESSAGES[code];
    if (error.status === 403) return "You don't have permission to do that.";
  }
  return "Couldn't save. Check your connection and try again.";
}
