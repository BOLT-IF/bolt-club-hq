import type { PublishOgPort } from "../core/ports";
import { createKvPublishOg } from "../share/og";

export interface EventsDeps {
  publishOg: (env: Cloudflare.Env) => PublishOgPort;
}

const defaults: EventsDeps = { publishOg: createKvPublishOg };

let deps: EventsDeps = defaults;

/** S7.1 calls this with the real publisher; tests pass a FakePublishOg. Call with {} to reset. */
export function configureEventsDeps(next: Partial<EventsDeps>): void {
  deps = { ...defaults, ...next };
}

export function eventsDeps(): EventsDeps {
  return deps;
}
