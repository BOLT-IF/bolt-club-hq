import { and, eq, inArray } from "drizzle-orm";

import { rsvp } from "../../../db/schema";
import type { RsvpCancelPort } from "../members/rsvp-cancel";
import { cancelMemberRsvps } from "./model";
import { lateCancelRsvp } from "./postclose";

export { cancelMemberRsvps };

const ACTIVE = ["requested", "confirmed", "waitlisted", "offered"] as const;

/**
 * Production `rsvp.cancel` port (PLAN §6.7, S2.1/S4.2/S4.4a): cancels pre-close RSVPs for free
 * and runs post-close late-cancel (with guest cascade, promotion, and refill) on future closed events.
 */
export const realRsvpCancel: RsvpCancelPort = {
  cancelFutureRsvps: async (input) => {
    await cancelMemberRsvps(input.db, input.clock, input);
    const remaining = await input.db
      .select({ eventId: rsvp.eventId })
      .from(rsvp)
      .where(and(eq(rsvp.memberId, input.memberId), inArray(rsvp.status, [...ACTIVE])));
    for (const { eventId } of remaining) {
      await lateCancelRsvp(input.db, input.clock, { eventId, memberId: input.memberId });
    }
  },
};
