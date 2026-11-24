import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";

/**
 * A tick hook runs inside a due scheduler run, with the database already open.
 * Register at module load, like `registerCronHook`. Hooks must be idempotent: a failed
 * run is retried on the next tick. Call `markDue` to schedule the next wake-up.
 */
export interface TickContext {
  db: Db;
  clock: Clock;
  now: Date;
  cron: string;
}
export type TickHook = (ctx: TickContext) => Promise<void>;

const hooks = new Map<string, TickHook>();

export function registerTickHook(name: string, hook: TickHook): void {
  hooks.set(name, hook);
}

export function tickHooks(): ReadonlyMap<string, TickHook> {
  return hooks;
}

/** Test helper: clears all registered tick hooks. */
export function resetTickHooks(): void {
  hooks.clear();
}
