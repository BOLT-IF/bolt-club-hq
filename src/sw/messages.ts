/** Message types exchanged between the page (src/sw/client.ts) and the service worker (src/sw/sw.ts). */
export const MSG = {
  /** page → SW: delete every app cache (sent on logout). Replies on the message port. */
  CLEAR_APP_CACHES: "CLEAR_APP_CACHES",
  /** page → SW: a waiting worker should activate now (the user accepted the update prompt). */
  SKIP_WAITING: "SKIP_WAITING",
  /** SW → page: an allowlisted GET was answered from cache because the network failed. */
  STALE: "STALE",
  /** SW → page: an allowlisted GET was answered from the network again. */
  FRESH: "FRESH",
} as const;

export type ClientMessage = { type: typeof MSG.CLEAR_APP_CACHES | typeof MSG.SKIP_WAITING };
export type WorkerMessage = { type: typeof MSG.STALE | typeof MSG.FRESH };
