import { renderTemplate } from "./template";
import type { EventUnrsvpedParams, PaymentDueParams, PlannedSend, ReminderRule } from "./types";

const TZ = "Europe/Stockholm";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Events carry no publish time and a term's events are generated at once, so the "at publish"
 * reminder goes out when an open event first comes within this many days (DECISIONS, S6.5a).
 */
export const PUBLISH_LOOKAHEAD_DAYS = 7;

type Rule<K extends ReminderRule["kind"]> = Extract<ReminderRule, { kind: K }>;

/** The club-local calendar date ("2027-04-01") of an instant. */
export function stockholmDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at);
}

/** Whole calendar days between two club-local dates; DST does not shift the count. */
function daysBetween(from: Date, to: Date): number {
  const day = (d: Date) => Date.parse(`${stockholmDate(d)}T00:00:00Z`);
  return Math.round((day(to) - day(from)) / DAY_MS);
}

function formatLocal(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  }).format(at);
}

export interface PaymentMember {
  id: string;
  displayName: string;
  paymentRef: string;
  /** Ledger balance in whole kronor; positive means the member owes. */
  balanceSek: number;
  /** When this rule last reminded the member, or null. */
  lastSentAt: Date | null;
}

/**
 * Payment due (PLAN §10): balance ≥ threshold, at most every `minIntervalDays` club-local
 * calendar days. A balance below the threshold (after paying) stops the reminders.
 */
export function planPaymentDue(
  rule: Rule<"payment_due">,
  input: { now: Date; members: readonly PaymentMember[] },
): PlannedSend[] {
  const params: PaymentDueParams = rule.params;
  const today = stockholmDate(input.now);
  return input.members
    .filter((m) => m.balanceSek >= params.thresholdSek)
    .filter(
      (m) => m.lastSentAt === null || daysBetween(m.lastSentAt, input.now) >= rule.minIntervalDays,
    )
    .map((m) => ({
      ruleId: rule.id,
      memberId: m.id,
      displayName: m.displayName,
      key: `reminder:${rule.id}:${m.id}:${today}`,
      title: "Payment reminder",
      body: renderTemplate(rule.template, {
        name: m.displayName,
        balance: `${String(m.balanceSek)} kr`,
        paymentRef: m.paymentRef,
      }),
      link: "/money",
    }));
}

export interface OpenEvent {
  id: string;
  title: string;
  slug: string;
  startsAt: Date;
  rsvpCloseAt: Date;
}

export interface EventUnrsvpedInput {
  now: Date;
  /** Scheduled events; the evaluator skips those whose RSVPs have closed. */
  events: readonly OpenEvent[];
  /** Members who may RSVP (active). */
  members: ReadonlyArray<{ id: string; displayName: string }>;
  /** `${eventId}:${memberId}` for every member with any RSVP row on the event. */
  responded: ReadonlySet<string>;
  /** Keys already sent (send log), so each stage goes out once. */
  sentKeys: ReadonlySet<string>;
}

/** Which stage of an un-RSVPed reminder is due now, if any. */
function dueStage(params: EventUnrsvpedParams, event: OpenEvent, now: Date) {
  const close = event.rsvpCloseAt.getTime();
  const t = now.getTime();
  if (t >= close) return null;
  const preClose =
    params.hoursBeforeClose === null ? null : close - params.hoursBeforeClose * HOUR_MS;
  if (preClose !== null && t >= preClose) return "close" as const;
  // "At publish": the first run while the event is open and near, before the pre-close window.
  const near = event.startsAt.getTime() - t <= PUBLISH_LOOKAHEAD_DAYS * DAY_MS;
  return params.atPublish && near ? ("publish" as const) : null;
}

/**
 * Un-RSVPed event (PLAN §10): members with no RSVP on an open event are reminded once at
 * publish and/or once `hoursBeforeClose` before RSVPs close. Members who responded are skipped.
 */
export function planEventUnrsvped(
  rule: Rule<"event_unrsvped">,
  input: EventUnrsvpedInput,
): PlannedSend[] {
  const sends: PlannedSend[] = [];
  for (const event of input.events) {
    const stage = dueStage(rule.params, event, input.now);
    if (stage === null) continue;
    for (const m of input.members) {
      if (input.responded.has(`${event.id}:${m.id}`)) continue;
      const key = `reminder:${rule.id}:${event.id}:${m.id}:${stage}`;
      if (input.sentKeys.has(key)) continue;
      sends.push({
        ruleId: rule.id,
        memberId: m.id,
        displayName: m.displayName,
        key,
        title: event.title,
        body: renderTemplate(rule.template, {
          name: m.displayName,
          event: event.title,
          when: formatLocal(event.startsAt),
          closes: formatLocal(event.rsvpCloseAt),
        }),
        link: `/events/${event.slug}`,
      });
    }
  }
  return sends;
}

/**
 * The earliest future instant at which `rule` could fire for these events (an event coming
 * within the publish lookahead, or a pre-close window opening), so the worker can wake the
 * scheduler. Null when nothing is pending.
 */
export function nextEventWakeUp(
  rule: Rule<"event_unrsvped">,
  events: readonly OpenEvent[],
  now: Date,
): Date | null {
  const { atPublish, hoursBeforeClose } = rule.params;
  const times = events
    .filter((e) => e.rsvpCloseAt.getTime() > now.getTime())
    .flatMap((e) => [
      atPublish ? e.startsAt.getTime() - PUBLISH_LOOKAHEAD_DAYS * DAY_MS : null,
      hoursBeforeClose === null ? null : e.rsvpCloseAt.getTime() - hoursBeforeClose * HOUR_MS,
    ])
    .filter((t): t is number => t !== null && t > now.getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}
