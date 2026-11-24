/**
 * `rsvp.cancel` port (STORIES S2.1, PLAN §6.7). Deactivating a member cancels their future
 * RSVPs through this seam. The RSVP area does not exist yet, so production wires a no-op;
 * the RSVP story replaces it with `configureRsvpCancel(realAdapter)` (or by changing the
 * default below) and deletes the no-op, with a test that the fake is not in production wiring.
 */
export interface RsvpCancelPort {
  /**
   * Cancels every RSVP (and guest) of `memberId` for events starting after `at`, applying the
   * late-cancel rules. Must be idempotent for the same `idempotencyKey`: a retry after a
   * partial failure calls it again with the same key.
   */
  cancelFutureRsvps(input: { memberId: string; at: Date; idempotencyKey: string }): Promise<void>;
}

/** Production stand-in until the RSVP story ships. Cancels nothing. */
export const noopRsvpCancel: RsvpCancelPort = {
  cancelFutureRsvps: () => Promise.resolve(),
};

let port: RsvpCancelPort = noopRsvpCancel;

/** Overrides the port (tests, and the RSVP story's wiring). `undefined` restores the default. */
export function configureRsvpCancel(next: RsvpCancelPort | undefined): void {
  port = next ?? noopRsvpCancel;
}

export function getRsvpCancel(): RsvpCancelPort {
  return port;
}
