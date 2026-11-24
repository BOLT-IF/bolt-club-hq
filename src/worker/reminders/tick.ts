import { registerTickHook } from "../scheduler/registry";
import { markDue } from "../scheduler/schedule";
import { runReminders } from "./service";

// Loaded through routes.ts (the backend registry imports every area's routes.ts eagerly).
// Runs on every due scheduler run and at least daily; it schedules its next pre-close
// or publish wake-up itself.
registerTickHook("reminders", async ({ db, clock, kv }) => {
  const { wakeUp } = await runReminders({ db, clock });
  if (wakeUp) await markDue(kv, wakeUp);
});
