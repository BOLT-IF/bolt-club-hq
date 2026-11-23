/**
 * Cron hook registry. Feature stories register named hooks here; the scheduled
 * handler (added by S0.7/S6.x) runs every hook registered for a cron expression.
 */
export type CronHook = (ctx: { scheduledAt: Date; cron: string }) => Promise<void>;

const hooks = new Map<string, CronHook[]>();

export function registerCronHook(cron: string, hook: CronHook): void {
  const list = hooks.get(cron) ?? [];
  list.push(hook);
  hooks.set(cron, list);
}

export function cronHooksFor(cron: string): readonly CronHook[] {
  return hooks.get(cron) ?? [];
}

/** Test helper: clears all registered hooks. */
export function resetCronHooks(): void {
  hooks.clear();
}
