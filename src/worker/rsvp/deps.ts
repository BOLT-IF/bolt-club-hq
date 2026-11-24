import type { Db } from "../core/db/client";
import type { PrepaidPort } from "../core/ports";

export interface RsvpDeps {
  /** Tier source (PLAN §6.1). Gets the request's db so S5.3 can query passes. */
  prepaid: (db: Db) => PrepaidPort;
}

/**
 * Production stand-in until S5.3 (passes): nobody is prepaid, so every series RSVP is tier 2
 * and Requested before close. S5.3 calls `configureRsvpDeps({ prepaid })` and removes this.
 */
export const nobodyPrepaid: PrepaidPort = { isPrepaid: () => Promise.resolve(false) };

const defaults: RsvpDeps = { prepaid: () => nobodyPrepaid };

let deps: RsvpDeps = defaults;

/** Tests pass a FakePrepaid; S5.3 passes the real pass lookup. Call with {} to reset. */
export function configureRsvpDeps(next: Partial<RsvpDeps>): void {
  deps = { ...defaults, ...next };
}

export function rsvpDeps(): RsvpDeps {
  return deps;
}
