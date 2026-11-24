import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";

/**
 * Delivery policy chain (PLAN §10: mute → quiet hours → frequency cap). Policies only
 * decide about the *push*; the inbox row is always written first.
 *
 * To add a policy, drop a file in `src/worker/notifications/policies/` that default-exports
 * a `NotificationPolicy`. It is picked up automatically. Use the `order` slots 10 (mute),
 * 20 (quiet hours) and 30 (frequency cap). Policies run in ascending order and the first
 * decision that is not "allow" wins.
 */
export interface PolicyContext {
  db: Db | Tx;
  clock: Clock;
  notification: {
    id: string;
    memberId: string;
    category: string;
    title: string;
    body: string;
    link: string | null;
  };
}

export type PolicyDecision =
  | { action: "allow" }
  /** Never push this notification. */
  | { action: "suppress"; reason: string }
  /** Push it, but not before `until` (quiet hours). */
  | { action: "defer"; until: Date; reason: string };

export interface NotificationPolicy {
  id: string;
  order: number;
  evaluate(ctx: PolicyContext): Promise<PolicyDecision>;
}

export async function runPolicyChain(
  policies: readonly NotificationPolicy[],
  ctx: PolicyContext,
): Promise<PolicyDecision> {
  for (const policy of [...policies].sort((a, b) => a.order - b.order)) {
    const decision = await policy.evaluate(ctx);
    if (decision.action !== "allow") return decision;
  }
  return { action: "allow" };
}

export function loadPolicies(
  modules: Record<string, { default: NotificationPolicy }>,
): NotificationPolicy[] {
  return Object.values(modules)
    .map((mod) => mod.default)
    .sort((a, b) => a.order - b.order);
}

/** Every policy file under ./policies/ (none in S6.1; S6.2 and S6.3 add theirs). */
export const defaultPolicies: NotificationPolicy[] = loadPolicies(
  import.meta.glob<{ default: NotificationPolicy }>(["./policies/*.ts", "!./policies/*.test.ts"], {
    eager: true,
  }),
);
