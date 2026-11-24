import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import { realRsvpCancel } from "../rsvp/cancel";

/**
 * `rsvp.cancel` port (STORIES S2.1, PLAN §6.7). Deactivating a member cancels their future
 * RSVPs through this seam. Production defaults to `realRsvpCancel`.
 */
export interface RsvpCancelPort {
  /**
   * Cancels every RSVP (and guest) of `memberId` for events starting after `at`, applying the
   * late-cancel rules. Must be idempotent for the same `idempotencyKey`: a retry after a
   * partial failure calls it again with the same key.
   */
  cancelFutureRsvps(input: {
    db: Db;
    clock: Clock;
    memberId: string;
    at: Date;
    idempotencyKey: string;
  }): Promise<void>;
}

let port: RsvpCancelPort = realRsvpCancel;

/** Overrides the port (tests). `undefined` restores the production implementation. */
export function configureRsvpCancel(next: RsvpCancelPort | undefined): void {
  port = next ?? realRsvpCancel;
}

export function getRsvpCancel(): RsvpCancelPort {
  return port;
}
