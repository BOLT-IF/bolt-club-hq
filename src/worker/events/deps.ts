import type { PublishOgPort } from "../core/ports";

export interface EventsDeps {
  publishOg: (env: Cloudflare.Env) => PublishOgPort;
}

/** Production no-op until S7.1 supplies the KV-backed implementation (STORIES S7.1). */
export const noopPublishOg: PublishOgPort = { publishOg: () => Promise.resolve() };

const defaults: EventsDeps = { publishOg: () => noopPublishOg };

let deps: EventsDeps = defaults;

/** S7.1 calls this with the real publisher; tests pass a FakePublishOg. Call with {} to reset. */
export function configureEventsDeps(next: Partial<EventsDeps>): void {
  deps = { ...defaults, ...next };
}

export function eventsDeps(): EventsDeps {
  return deps;
}
