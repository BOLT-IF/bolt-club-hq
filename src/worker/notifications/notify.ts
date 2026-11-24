import { eq } from "drizzle-orm";

import { member, notification, outboundPush } from "../../../db/schema";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import type { NotifyPort } from "../core/ports";
import { isCategory, resolveLink } from "./links";
import { defaultPolicies, runPolicyChain, type NotificationPolicy } from "./policy";
import { markPushDue } from "./push-cron";

/** `NotifyPort` input plus an optional in-app deep link (default: the category's screen). */
export type NotifyInput = Parameters<NotifyPort["notify"]>[0] & { link?: string };

export interface NotifyDeps {
  /** Pass a transaction to make the notification commit or roll back with the caller's work. */
  db: Db | Tx;
  clock: Clock;
  policies?: readonly NotificationPolicy[];
  /** Called when a policy throws. The push is then dropped (fail closed). */
  onPolicyError?: (policyError: unknown, notificationId: string) => void;
}

/**
 * Production `NotifyPort` (S6.1). In one transaction: write the inbox row (the source of
 * truth), run the policy chain, and queue an `outbound_push` row unless a policy suppresses
 * it. Sending the queued rows is S6.2.
 *
 * Idempotent on `idempotencyKey`: only the call whose insert lands runs the policies and
 * queues a push, so a retry never adds a second push, even after a suppression.
 */
export function createNotifyPort(deps: NotifyDeps): { notify(input: NotifyInput): Promise<void> } {
  const policies = deps.policies ?? defaultPolicies;

  return {
    async notify(input) {
      if (!isCategory(input.category)) {
        throw new Error(`notify: unknown category "${input.category}"`);
      }
      const category = input.category;

      await deps.db.transaction(async (tx) => {
        const [recipient] = await tx
          .select({ role: member.role })
          .from(member)
          .where(eq(member.id, input.memberId));
        // admin_tasks are for admins only; anything else is dropped, not an error.
        if (category === "admin_tasks" && recipient?.role !== "admin") return;

        const id = `ntf_${input.idempotencyKey}`;
        const link = resolveLink(category, input.link);
        const inserted = await tx
          .insert(notification)
          .values({
            id,
            memberId: input.memberId,
            category,
            title: input.title,
            body: input.body,
            link,
            createdAt: deps.clock.now(),
            idempotencyKey: input.idempotencyKey,
          })
          .onConflictDoNothing({ target: notification.idempotencyKey })
          .returning({ id: notification.id });
        if (inserted.length === 0) return;

        // A savepoint keeps a failing policy query from aborting the inbox write.
        const decision = await tx
          .transaction((sp) =>
            runPolicyChain(policies, {
              db: sp,
              clock: deps.clock,
              notification: {
                id,
                memberId: input.memberId,
                category,
                title: input.title,
                body: input.body,
                link,
              },
            }),
          )
          .catch((error: unknown) => {
            deps.onPolicyError?.(error, id);
            return { action: "suppress" as const, reason: "policy error" };
          });
        if (decision.action === "suppress") return;

        // Seam for S6.2: a cron hook sends queued rows (and deferred rows once not_before passes).
        await tx.insert(outboundPush).values({
          id: `push_${id}`,
          notificationId: id,
          status: decision.action === "defer" ? "deferred" : "queued",
          notBefore: decision.action === "defer" ? decision.until : null,
        });
        await markPushDue(decision.action === "defer" ? decision.until : deps.clock.now());
      });
    },
  };
}
