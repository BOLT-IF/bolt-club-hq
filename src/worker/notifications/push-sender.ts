import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { notification, outboundPush, pushSubscription } from "../../../db/schema";
import type { Clock } from "../core/clock";
import type { Db } from "../core/db/client";
import { clubQuietHours, quietUntil } from "./policies/quiet-hours";
import type { PushResult, PushTransport, StoredSubscription } from "./push-transport";

/**
 * Max sends (one encryption + POST each) per cron run. PROVISIONAL: PLAN §11 says at most
 * 10, S0.6 has not measured the real CPU cost yet. Change this one constant after S0.6
 * (DECISIONS 2026-11-24, S6.2).
 */
export const PUSH_BATCH_CAP = 20;

/** Attempts per outbound_push row before it is marked failed (5xx / network only). */
export const MAX_PUSH_ATTEMPTS = 5;

/** First retry after 10 minutes (one cron tick), doubling: 10, 20, 40, 80. */
export const PUSH_BACKOFF_BASE_MS = 10 * 60_000;

export interface SendPushDeps {
  db: Db;
  clock: Clock;
  transport: PushTransport;
  batchCap?: number;
}

export interface SendPushResult {
  sends: number;
  sent: number;
  failed: number;
  deferred: number;
}

/**
 * One cron run of the push sender. Takes due `outbound_push` rows (`queued`, or `deferred`
 * once `not_before <= now`) oldest first and sends each to every device of its member,
 * stopping before the run would exceed `batchCap` sends.
 *
 * Per device: 2xx stamps `last_success_at`; 404/410 deletes the subscription; 5xx, 429 or a
 * network error counts a failure. Per row: any device reached → `sent`; else a retryable
 * error and attempts left → `deferred` with exponential backoff (never into quiet hours);
 * else `failed`. The inbox row is untouched either way.
 *
 * Relies on the scheduler not running two ticks at once (S6.4 overlap lock).
 */
export async function sendPushBatch(deps: SendPushDeps): Promise<SendPushResult> {
  const cap = deps.batchCap ?? PUSH_BATCH_CAP;
  const now = deps.clock.now();
  const result: SendPushResult = { sends: 0, sent: 0, failed: 0, deferred: 0 };

  // Each row needs at least one send, so `cap` rows is enough to fill the batch.
  const due = await deps.db
    .select({
      id: outboundPush.id,
      attempts: outboundPush.attempts,
      notificationId: notification.id,
      memberId: notification.memberId,
      title: notification.title,
      body: notification.body,
      link: notification.link,
    })
    .from(outboundPush)
    .innerJoin(notification, eq(notification.id, outboundPush.notificationId))
    .where(
      and(
        inArray(outboundPush.status, ["queued", "deferred"]),
        or(isNull(outboundPush.notBefore), lte(outboundPush.notBefore, now)),
      ),
    )
    .orderBy(sql`${outboundPush.notBefore} asc nulls first`, asc(notification.createdAt))
    .limit(cap);
  if (due.length === 0) return result;

  const subs = await deps.db
    .select()
    .from(pushSubscription)
    .where(
      inArray(
        pushSubscription.memberId,
        due.map((r) => r.memberId),
      ),
    )
    .orderBy(asc(pushSubscription.createdAt), asc(pushSubscription.id));

  let quiet: Awaited<ReturnType<typeof clubQuietHours>> | undefined;

  for (const row of due) {
    const devices = subs.filter((s) => s.memberId === row.memberId);
    if (result.sends > 0 && result.sends + devices.length > cap) break;
    // A member with more devices than the cap (unrealistic) gets the first `cap` of them.
    const targets = devices.slice(0, cap);

    const outcomes: PushResult[] = [];
    for (const device of targets) {
      const outcome = await deps.transport.send(device as StoredSubscription & typeof device, {
        title: row.title,
        body: row.body,
        url: row.link ?? "/inbox",
        tag: row.notificationId,
      });
      outcomes.push(outcome);
      result.sends++;
      await recordDeviceOutcome(deps.db, device.id, outcome, now);
    }

    const attempts = row.attempts + 1;
    if (outcomes.some((o) => o.kind === "ok")) {
      await setRow(deps.db, row.id, { status: "sent", attempts });
      result.sent++;
    } else if (outcomes.some((o) => o.kind === "retry") && attempts < MAX_PUSH_ATTEMPTS) {
      const retryAt = new Date(now.getTime() + PUSH_BACKOFF_BASE_MS * 2 ** (attempts - 1));
      quiet ??= await clubQuietHours(deps.db);
      const notBefore = quietUntil(retryAt, quiet) ?? retryAt;
      await setRow(deps.db, row.id, { status: "deferred", attempts, notBefore });
      result.deferred++;
    } else {
      // No device, every device gone/rejected, or out of attempts. The inbox still has it.
      await setRow(deps.db, row.id, { status: "failed", attempts });
      result.failed++;
    }
  }
  return result;
}

async function recordDeviceOutcome(db: Db, id: string, outcome: PushResult, now: Date) {
  const where = eq(pushSubscription.id, id);
  if (outcome.kind === "ok") {
    await db.update(pushSubscription).set({ lastSuccessAt: now, failures: 0 }).where(where);
  } else if (outcome.kind === "gone") {
    await db.delete(pushSubscription).where(where);
  } else {
    await db
      .update(pushSubscription)
      .set({ failures: sql`${pushSubscription.failures} + 1` })
      .where(where);
  }
}

function setRow(
  db: Db,
  id: string,
  values: { status: "sent" | "failed" | "deferred"; attempts: number; notBefore?: Date },
) {
  return db.update(outboundPush).set(values).where(eq(outboundPush.id, id));
}
