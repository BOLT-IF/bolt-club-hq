import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import type { RsvpCancelPort } from "../members/rsvp-cancel";
import { cancelMemberRsvps } from "./model";

export { cancelMemberRsvps };

/** Production `rsvp.cancel` port (PLAN §6.7, S2.1/S4.2): cancels pre-close RSVPs on member exit. */
export const realRsvpCancel: RsvpCancelPort = {
  cancelFutureRsvps: (input) => cancelMemberRsvps(input.db, input.clock, input),
};

export function rsvpCancelAdapter(db: Db, clock: Clock) {
  return {
    cancelFutureRsvps: (input: { memberId: string; at: Date; idempotencyKey: string }) =>
      cancelMemberRsvps(db, clock, input),
  };
}
