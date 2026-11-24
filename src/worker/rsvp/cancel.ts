import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import { cancelMemberRsvps } from "./model";

export { cancelMemberRsvps };

/**
 * Adapter in the shape of S2.1's `RsvpCancelPort` (`src/worker/members/rsvp-cancel.ts`, PR #30).
 * Members code is not touched here: the integrator (or S2.1) wires it, e.g.
 * `configureRsvpCancel(rsvpCancelAdapter(c.var.db, c.var.clock))`. See DECISIONS 2026-11-24 S4.2.
 */
export function rsvpCancelAdapter(db: Db, clock: Clock) {
  return {
    cancelFutureRsvps: (input: { memberId: string; at: Date; idempotencyKey: string }) =>
      cancelMemberRsvps(db, clock, input),
  };
}
