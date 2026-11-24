import { and, eq, gt, inArray, max, sql, sum } from "drizzle-orm";

import {
  event,
  ledgerEntry,
  member,
  notificationSendLog,
  reminderRule,
  rsvp,
} from "../../../db/schema";
import {
  nextEventWakeUp,
  planEventUnrsvped,
  planPaymentDue,
  type PlannedSend,
  type ReminderRule,
  type RuleKind,
} from "../../domain/reminders";
import type { Clock } from "../core/clock";
import type { Db, Tx } from "../core/db/client";
import { createNotifyPort } from "../notifications/notify";
import type { NotificationPolicy } from "../notifications/policy";

type Row = typeof reminderRule.$inferSelect;

/** Rule kind → notification category (PLAN §10), so members mute reminders per category. */
const CATEGORY: Record<RuleKind, string> = {
  payment_due: "payment_due",
  event_unrsvped: "new_events",
};

export function toRule(row: Row): ReminderRule {
  return {
    id: row.id,
    kind: row.category as RuleKind,
    enabled: row.enabled,
    minIntervalDays: row.minIntervalDays,
    template: row.template,
    params: row.params,
  } as ReminderRule;
}

async function planPayment(
  db: Db | Tx,
  rule: Extract<ReminderRule, { kind: "payment_due" }>,
  now: Date,
): Promise<PlannedSend[]> {
  // Balance = Σ amount_sek (docs/areas/ledger.md), one grouped query instead of a call per member.
  // Inactive (exited) members keep getting reminders while they owe (PLAN §6.7).
  const balances = await db
    .select({
      id: member.id,
      displayName: member.displayName,
      paymentRef: member.paymentRef,
      balance: sum(ledgerEntry.amountSek).mapWith(Number),
    })
    .from(member)
    .innerJoin(ledgerEntry, eq(ledgerEntry.memberId, member.id))
    .where(inArray(member.status, ["active", "inactive"]))
    .groupBy(member.id)
    .having(sql`sum(${ledgerEntry.amountSek}) >= ${rule.params.thresholdSek}`);
  if (balances.length === 0) return [];

  const last = await db
    .select({ memberId: notificationSendLog.memberId, at: max(notificationSendLog.sentAt) })
    .from(notificationSendLog)
    .where(eq(notificationSendLog.ruleId, rule.id))
    .groupBy(notificationSendLog.memberId);
  const lastBy = new Map(last.map((l) => [l.memberId, l.at]));

  return planPaymentDue(rule, {
    now,
    members: balances.map((b) => ({
      id: b.id,
      displayName: b.displayName,
      paymentRef: b.paymentRef,
      balanceSek: b.balance,
      lastSentAt: lastBy.get(b.id) ?? null,
    })),
  });
}

async function loadOpenEvents(db: Db | Tx, now: Date) {
  return db
    .select({
      id: event.id,
      title: event.title,
      slug: event.shareSlug,
      startsAt: event.startsAt,
      rsvpCloseAt: event.rsvpCloseAt,
    })
    .from(event)
    .where(and(eq(event.status, "scheduled"), gt(event.rsvpCloseAt, now)));
}

async function planEvents(
  db: Db | Tx,
  rule: Extract<ReminderRule, { kind: "event_unrsvped" }>,
  now: Date,
): Promise<{ sends: PlannedSend[]; wakeUp: Date | null }> {
  const events = await loadOpenEvents(db, now);
  if (events.length === 0) return { sends: [], wakeUp: null };
  const ids = events.map((e) => e.id);
  const [members, responses, sent] = await Promise.all([
    db
      .select({ id: member.id, displayName: member.displayName })
      .from(member)
      .where(eq(member.status, "active")),
    // Any RSVP row counts as a response, including a cancellation.
    db
      .select({ eventId: rsvp.eventId, memberId: rsvp.memberId })
      .from(rsvp)
      .where(inArray(rsvp.eventId, ids)),
    db
      .select({ id: notificationSendLog.id })
      .from(notificationSendLog)
      .where(eq(notificationSendLog.ruleId, rule.id)),
  ]);
  return {
    sends: planEventUnrsvped(rule, {
      now,
      events,
      members,
      responded: new Set(responses.map((r) => `${r.eventId}:${r.memberId}`)),
      sentKeys: new Set(sent.map((s) => s.id)),
    }),
    wakeUp: nextEventWakeUp(rule, events, now),
  };
}

/** What `rule` would send right now. The preview and the real run both use this. */
export async function planRule(
  db: Db | Tx,
  rule: ReminderRule,
  now: Date,
): Promise<{ sends: PlannedSend[]; wakeUp: Date | null }> {
  return rule.kind === "payment_due"
    ? { sends: await planPayment(db, rule, now), wakeUp: null }
    : planEvents(db, rule, now);
}

export interface RunDeps {
  db: Db;
  clock: Clock;
  /** Notification policies; production uses the auto-registered chain. */
  policies?: readonly NotificationPolicy[];
}

/**
 * Sends every enabled rule's due reminders. Each send writes the inbox row (through the notify
 * policy chain, so mute keeps the inbox entry and drops the push) and the send log row in one
 * transaction, both keyed by the send's key, so a retried tick sends nothing twice.
 * Returns the number sent and the earliest future wake-up.
 */
export async function runReminders(deps: RunDeps): Promise<{ sent: number; wakeUp: Date | null }> {
  const now = deps.clock.now();
  const rows = await deps.db.select().from(reminderRule).where(eq(reminderRule.enabled, true));
  let sent = 0;
  let wakeUp: Date | null = null;
  for (const rule of rows.map(toRule)) {
    const plan = await planRule(deps.db, rule, now);
    if (plan.wakeUp && (!wakeUp || plan.wakeUp < wakeUp)) wakeUp = plan.wakeUp;
    for (const send of plan.sends) {
      await deps.db.transaction(async (tx) => {
        const logged = await tx
          .insert(notificationSendLog)
          .values({
            id: send.key,
            memberId: send.memberId,
            category: CATEGORY[rule.kind],
            ruleId: rule.id,
            sentAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: notificationSendLog.id });
        if (logged.length === 0) return;
        const notifyDeps = deps.policies
          ? { db: tx, clock: deps.clock, policies: deps.policies }
          : { db: tx, clock: deps.clock };
        await createNotifyPort(notifyDeps).notify({
          memberId: send.memberId,
          category: CATEGORY[rule.kind],
          title: send.title,
          body: send.body,
          link: send.link,
          idempotencyKey: send.key,
        });
        sent++;
      });
    }
  }
  return { sent, wakeUp };
}
