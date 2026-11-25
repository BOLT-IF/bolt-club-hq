import { registerTickHook, type TickContext } from "../scheduler/registry";
import { markDue } from "../scheduler/schedule";
import { closeDueEvents, nextCloseDueAt } from "./close";

export const CLOSE_TICK_HOOK = "rsvp-close";

/**
 * Closes every due event and schedules the scheduler's next wake-up for the earliest
 * remaining unclosed event (PLAN §6.3, S6.4).
 */
export async function runCloseTick(
  ctx: Pick<TickContext, "db" | "clock" | "now"> & { kv?: KVNamespace },
): Promise<void> {
  await closeDueEvents(ctx.db, ctx.clock, { limit: null });
  if (!ctx.kv) return;
  const next = await nextCloseDueAt(ctx.db);
  if (!next) return;
  // scheduler/run.ts clears next_due_at if <= run start; bump a skipped-locked row past now.
  const wakeAt = new Date(Math.max(next.getTime(), ctx.now.getTime() + 1));
  await markDue(ctx.kv, wakeAt);
}

registerTickHook(CLOSE_TICK_HOOK, runCloseTick);
