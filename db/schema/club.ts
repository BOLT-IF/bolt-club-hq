import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

import { member } from "./identity";

export const termStatus = pgEnum("term_status", ["draft", "open_for_passes", "active", "closed"]);
export const termSeason = pgEnum("term_season", ["fall", "spring"]);
export const seriesFormat = pgEnum("series_format", ["MD", "WD", "XD", "mixed", "open"]);

export const clubSettings = pgTable("club_settings", {
  /** Singleton row: id is always 1. */
  id: integer("id").primaryKey().default(1),
  clubName: text("club_name").notNull(),
  bankDetails: text("bank_details"),
  paymentInstructions: text("payment_instructions"),
  quietHours: jsonb("quiet_hours"),
  passUnpaidRevokeDays: integer("pass_unpaid_revoke_days").notNull().default(21),
  autoPromoteCutoffMin: integer("auto_promote_cutoff_min").notNull().default(180),
  clubFeeFallSek: integer("club_fee_fall_sek").notNull().default(160),
  clubFeeSpringSek: integer("club_fee_spring_sek").notNull().default(85),
  defaults: jsonb("defaults"),
  accountingAccountCodes: jsonb("accounting_account_codes"),
  rosterAppUrl: text("roster_app_url"),
});

export const term = pgTable("term", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  season: termSeason("season"),
  clubYear: integer("club_year"),
  status: termStatus("status").notNull().default("draft"),
  clonedFromTermId: text("cloned_from_term_id"),
});

export const series = pgTable("series", {
  id: text("id").primaryKey(),
  termId: text("term_id")
    .notNull()
    .references(() => term.id),
  name: text("name").notNull(),
  format: seriesFormat("format").notNull(),
  level: text("level"),
  weekday: integer("weekday").notNull(),
  startTime: text("start_time").notNull(),
  durationMin: integer("duration_min").notNull(),
  location: text("location"),
  capacity: integer("capacity").notNull(),
  passPrice: integer("pass_price").notNull(),
  discountedPassPrice: integer("discounted_pass_price"),
  adhocFee: integer("adhoc_fee").notNull(),
  maxGuestsDefault: integer("max_guests_default").notNull().default(0),
  rsvpCloseOffsetMin: integer("rsvp_close_offset_min").notNull().default(1440),
  shareSlug: text("share_slug").notNull().unique(),
  skipDates: date("skip_dates").array().notNull().default([]),
  skipDatesLocked: boolean("skip_dates_locked").notNull().default(false),
  passCap: integer("pass_cap").notNull(),
});

export const seriesCaptain = pgTable(
  "series_captain",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.memberId] })],
);

export const seriesDiscountEligible = pgTable(
  "series_discount_eligible",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.memberId] })],
);

export const eventKind = pgEnum("event_kind", ["series", "member_oneoff", "admin_oneoff"]);
export const eventStatus = pgEnum("event_status", [
  "scheduled",
  "closed",
  "cancelled",
  "completed",
]);
export const allocationMode = pgEnum("allocation_mode", ["tiered", "instant"]);

export const event = pgTable("event", {
  id: text("id").primaryKey(),
  seriesId: text("series_id").references(() => series.id),
  kind: eventKind("kind").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => member.id),
  title: text("title").notNull(),
  format: seriesFormat("format").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  location: text("location"),
  capacity: integer("capacity").notNull(),
  adhocFee: integer("adhoc_fee").notNull(),
  maxGuestsPerMember: integer("max_guests_per_member").notNull().default(0),
  rsvpCloseAt: timestamp("rsvp_close_at", { withTimezone: true }).notNull(),
  allocationMode: allocationMode("allocation_mode").notNull(),
  audienceKind: text("audience_kind").notNull().default("all"),
  audienceSeriesId: text("audience_series_id").references(() => series.id),
  status: eventStatus("status").notNull().default("scheduled"),
  shareSlug: text("share_slug").notNull().unique(),
  closedProcessedAt: timestamp("closed_processed_at", { withTimezone: true }),
  materialChangeAt: timestamp("material_change_at", { withTimezone: true }),
});

export const eventEligibleMember = pgTable(
  "event_eligible_member",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => event.id),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.memberId] })],
);

export const passStatus = pgEnum("pass_status", ["active", "revoked"]);

export const pass = pgTable("pass", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  seriesId: text("series_id")
    .notNull()
    .references(() => series.id),
  priceCharged: integer("price_charged").notNull(),
  eventsCovered: integer("events_covered").notNull(),
  status: passStatus("status").notNull().default("active"),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  grantedBy: text("granted_by").references(() => member.id),
});

export const rsvpStatus = pgEnum("rsvp_status", [
  "requested",
  "confirmed",
  "waitlisted",
  "offered",
  "cancelled",
  "late_cancelled",
  "declined",
]);
export const attendance = pgEnum("attendance", ["unknown", "attended", "no_show"]);

export const rsvp = pgTable("rsvp", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => event.id),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  status: rsvpStatus("status").notNull(),
  tier: integer("tier").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  refilled: boolean("refilled").notNull().default(false),
  attendance: attendance("attendance").notNull().default("unknown"),
});

export const guest = pgTable("guest", {
  id: text("id").primaryKey(),
  rsvpId: text("rsvp_id")
    .notNull()
    .references(() => rsvp.id),
  name: text("name").notNull(),
  status: rsvpStatus("status").notNull(),
  tier: integer("tier").notNull().default(3),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  refilled: boolean("refilled").notNull().default(false),
  attendance: attendance("attendance").notNull().default("unknown"),
});
