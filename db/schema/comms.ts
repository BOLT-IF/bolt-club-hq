import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { member } from "./identity";

export const outboundStatus = pgEnum("outbound_status", ["queued", "sent", "failed", "deferred"]);

export const notification = pgTable("notification", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  category: text("category").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
});

export const pushSubscription = pgTable("push_subscription", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  endpoint: text("endpoint").notNull().unique(),
  keys: jsonb("keys").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
});

export const notificationPref = pgTable(
  "notification_pref",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
    category: text("category").notNull(),
    muted: boolean("muted").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.category] })],
);

export const reminderRule = pgTable("reminder_rule", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  params: jsonb("params").notNull(),
  minIntervalDays: integer("min_interval_days").notNull().default(1),
  template: text("template").notNull(),
  updatedBy: text("updated_by").references(() => member.id),
});

export const notificationSendLog = pgTable("notification_send_log", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  category: text("category").notNull(),
  ruleId: text("rule_id").references(() => reminderRule.id),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboundPush = pgTable("outbound_push", {
  id: text("id").primaryKey(),
  notificationId: text("notification_id")
    .notNull()
    .references(() => notification.id),
  status: outboundStatus("status").notNull().default("queued"),
  notBefore: timestamp("not_before", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
});

export const schedulerState = pgTable("scheduler_state", {
  /** Singleton row: id is always 1. next_due_at is mirrored into Workers KV. */
  id: integer("id").primaryKey().default(1),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  lastTickDurationMs: integer("last_tick_duration_ms"),
  lastError: text("last_error"),
});

export const poll = pgTable("poll", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => member.id),
  closesAt: timestamp("closes_at", { withTimezone: true }),
});

export const pollOption = pgTable("poll_option", {
  id: text("id").primaryKey(),
  pollId: text("poll_id")
    .notNull()
    .references(() => poll.id),
  label: text("label").notNull(),
  imageKey: text("image_key"),
});

export const pollVote = pgTable(
  "poll_vote",
  {
    pollId: text("poll_id")
      .notNull()
      .references(() => poll.id),
    optionId: text("option_id")
      .notNull()
      .references(() => pollOption.id),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
    votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.memberId] })],
);

export const domainEventOutbox = pgTable("domain_event_outbox", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});
