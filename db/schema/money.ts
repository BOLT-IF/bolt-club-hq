import { integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { member } from "./identity";
import { event, guest, pass } from "./club";

export const ledgerKind = pgEnum("ledger_kind", ["charge", "payment", "reversal", "adjustment"]);
export const ledgerReason = pgEnum("ledger_reason", [
  "pass",
  "adhoc",
  "guest",
  "club_fee",
  "manual",
  "payment",
  "waiver",
  "revocation",
  "opening_balance",
]);
export const paymentClaimStatus = pgEnum("payment_claim_status", [
  "pending",
  "confirmed",
  "rejected",
]);
export const clubFeeSeason = pgEnum("club_fee_season", ["fall", "spring"]);
export const clubFeeKind = pgEnum("club_fee_kind", ["charged", "external_fall_paid", "exempt"]);

/**
 * Append-only ledger. Amounts are whole kronor (signed). A Postgres trigger
 * (db/migrations) rejects UPDATE and DELETE, except one-time `exported_at`.
 * Every row carries a unique idempotency key.
 */
export const ledgerEntry = pgTable("ledger_entry", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  kind: ledgerKind("kind").notNull(),
  amountSek: integer("amount_sek").notNull(),
  reason: ledgerReason("reason").notNull(),
  eventId: text("event_id").references(() => event.id),
  passId: text("pass_id").references(() => pass.id),
  guestId: text("guest_id").references(() => guest.id),
  paymentClaimId: text("payment_claim_id"),
  reversesEntryId: text("reverses_entry_id"),
  note: text("note").notNull().default(""),
  createdBy: text("created_by")
    .notNull()
    .references(() => member.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  exportedAt: timestamp("exported_at", { withTimezone: true }),
});

export const paymentClaim = pgTable("payment_claim", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  amountSek: integer("amount_sek").notNull(),
  paidOn: timestamp("paid_on", { withTimezone: true }).notNull(),
  note: text("note"),
  status: paymentClaimStatus("status").notNull().default("pending"),
  decidedBy: text("decided_by").references(() => member.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  rejectReason: text("reject_reason"),
});

export const clubFee = pgTable("club_fee", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  clubYear: integer("club_year").notNull(),
  season: clubFeeSeason("season").notNull(),
  kind: clubFeeKind("kind").notNull(),
  amountSek: integer("amount_sek").notNull(),
  ledgerEntryId: text("ledger_entry_id").references(() => ledgerEntry.id),
  note: text("note").notNull().default(""),
  recordedBy: text("recorded_by").references(() => member.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
