import type { ChargePort, ReversePort } from "../core/ports";
import { createLedgerService, type ChargeInput, type LedgerDeps } from "./service";

/** What `ChargePort` takes, plus the optional context the ledger can store with a charge. */
export type ChargePortInput = Parameters<ChargePort["charge"]>[0] &
  Pick<ChargeInput, "eventId" | "passId" | "guestId" | "note">;

/**
 * Production `ChargePort` (S5.1). Writes a system charge (no actor): integer kronor only,
 * `reason` one of pass, adhoc, guest or manual, one row per `idempotencyKey`. A retry of the
 * same key is a no-op. Pass the caller's transaction as `db` so the charge commits with
 * the caller's work (e.g. event close, PLAN §6.3). Rejects with a `LedgerError`.
 */
export function createChargePort(deps: LedgerDeps): {
  charge(input: ChargePortInput): Promise<void>;
} {
  const ledger = createLedgerService(deps);
  return {
    async charge(input) {
      await ledger.charge({
        memberId: input.memberId,
        amountSek: input.amountSek,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        ...(input.eventId !== undefined && { eventId: input.eventId }),
        ...(input.passId !== undefined && { passId: input.passId }),
        ...(input.guestId !== undefined && { guestId: input.guestId }),
        ...(input.note !== undefined && { note: input.note }),
      });
    },
  };
}

/**
 * Production `ReversePort` (S5.1). Appends a reversal of `entryId` (ledger rows are never
 * edited). Refuses a reversal of a reversal and a second reversal of the same entry, with
 * a `LedgerError`; the same `idempotencyKey` replays quietly. Callers should derive the key
 * from the entry (for example `reverse:${entryId}`) so a retry can never double-reverse.
 */
export function createReversePort(deps: LedgerDeps): ReversePort {
  const ledger = createLedgerService(deps);
  return {
    async reverse(input) {
      await ledger.reverse({ entryId: input.entryId, idempotencyKey: input.idempotencyKey });
    },
  };
}
