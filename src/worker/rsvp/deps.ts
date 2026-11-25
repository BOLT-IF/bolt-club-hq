import type { Db } from "../core/db/client";
import type { PrepaidPort } from "../core/ports";
import { createPrepaidPort } from "../passes/prepaid";

export interface RsvpDeps {
  /** Tier source (PLAN §6.1). Gets the request's db so S5.3 can query passes. */
  prepaid: (db: Db) => PrepaidPort;
}

const defaults: RsvpDeps = { prepaid: createPrepaidPort };

let deps: RsvpDeps = defaults;

/** Tests override this port; production defaults to `createPrepaidPort`. Call with {} to reset. */
export function configureRsvpDeps(next: Partial<RsvpDeps>): void {
  deps = { ...defaults, ...next };
}

export function rsvpDeps(): RsvpDeps {
  return deps;
}
