/**
 * Reminder rules (PLAN §10, S6.5a). A rule's `kind` is stored in `reminder_rule.category`.
 * Poll-closing reminders arrive with polls (S9.1); see DECISIONS 2026-11-24 (S6.5a).
 */
export const RULE_KINDS = ["payment_due", "event_unrsvped"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface PaymentDueParams {
  /** Remind when the balance owed is at least this many whole kronor. */
  thresholdSek: number;
}

export interface EventUnrsvpedParams {
  /** Remind once while the event is newly open for RSVPs. */
  atPublish: boolean;
  /** Remind once this many hours before RSVPs close; null for no pre-close reminder. */
  hoursBeforeClose: number | null;
}

interface RuleBase {
  id: string;
  enabled: boolean;
  /** Minimum days between two payment reminders to one member. */
  minIntervalDays: number;
  template: string;
}

export type ReminderRule =
  | (RuleBase & { kind: "payment_due"; params: PaymentDueParams })
  | (RuleBase & { kind: "event_unrsvped"; params: EventUnrsvpedParams });

/** One planned notification. `key` is the idempotency key for the inbox row and send log. */
export interface PlannedSend {
  ruleId: string;
  memberId: string;
  displayName: string;
  key: string;
  title: string;
  body: string;
  link: string;
}
