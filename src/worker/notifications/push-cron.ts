import { registerTickHook, type TickContext } from "../scheduler/registry";
import { markDue } from "../scheduler/schedule";
import { sendPushBatch } from "./push-sender";
import { createWebPushTransport, type PushTransport, type VapidConfig } from "./push-transport";

export const PUSH_TICK_HOOK = "push-sender";

/** Bindings the push sender reads. VAPID_* are secrets, so they are not in the generated Env. */
export interface PushEnv {
  KV?: KVNamespace;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** The Worker env. Read lazily: tick hooks and `notify` get no env, and Node tests have none. */
async function workerEnv(): Promise<PushEnv | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return env;
  } catch {
    return null;
  }
}

export function vapidFrom(env: PushEnv | null): VapidConfig | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env ?? {};
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return null;
  return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT };
}

/**
 * Wakes the scheduler for push work at `at` (S6.4 `next_due_at`). Best effort: without a KV
 * (Node tests) or on a KV error it does nothing; the daily maintenance run still sends.
 */
export async function markPushDue(at: Date, env?: PushEnv | null): Promise<void> {
  try {
    const kv = (env === undefined ? await workerEnv() : env)?.KV;
    if (kv) await markDue(kv, at);
  } catch {
    // Push is best effort; the inbox row is the source of truth.
  }
}

/**
 * One scheduler run of the sender. Skips (rows stay queued) while the VAPID secrets are
 * unset. Afterwards re-arms `next_due_at` for leftover or backed-off rows. The scheduler
 * clears a `next_due_at` that is not later than the run start, so "due now" becomes now + 1 ms.
 */
export async function runPushTick(
  ctx: Pick<TickContext, "db" | "clock" | "now">,
  env: PushEnv | null,
  transport?: PushTransport,
): Promise<void> {
  const vapid = vapidFrom(env);
  if (!vapid && !transport) return;
  const result = await sendPushBatch({
    db: ctx.db,
    clock: ctx.clock,
    transport: transport ?? createWebPushTransport({ vapid: vapid as VapidConfig }),
  });
  if (result.nextDueAt) {
    const soonest = ctx.now.getTime() + 1;
    await markPushDue(new Date(Math.max(result.nextDueAt.getTime(), soonest)), env);
  }
}

registerTickHook(PUSH_TICK_HOOK, async (ctx) => {
  await runPushTick(ctx, await workerEnv());
});
