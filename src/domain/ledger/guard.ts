export interface SelfLedgerInput {
  actorId: string;
  /** Owner of the ledger being written. */
  memberId: string;
  /** Active admins other than the actor. */
  otherActiveAdmins: number;
}

/**
 * Self-ledger guard (PLAN A11, invariant 7). An admin may not record payments, waivers,
 * reversals or manual entries on their own ledger. The one exception is the only admin,
 * who has nobody else to do it: allowed, but flagged so the audit log shows it.
 */
export function selfLedgerGuard(input: SelfLedgerInput): "allow" | "block" | "allow_flagged" {
  if (input.actorId !== input.memberId) return "allow";
  return input.otherActiveAdmins > 0 ? "block" : "allow_flagged";
}
