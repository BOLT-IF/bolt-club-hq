import { deleteStaleClaims } from "./cleanup";
import { registerTickHook } from "./registry";

// Built-in maintenance. Registered from here, through the scheduler's own registry, so
// no other area's files are touched (S6.4 Owns). It runs with every due run and at
// least once a day.
registerTickHook("idempotency-claim-cleanup", async ({ db, clock }) => {
  await deleteStaleClaims(db, clock);
});
