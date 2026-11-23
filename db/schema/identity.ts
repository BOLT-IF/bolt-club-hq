import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["member", "admin"]);
export const memberStatus = pgEnum("member_status", ["pending", "active", "inactive", "erased"]);
export const joinVia = pgEnum("join_via", ["invite", "event_link", "series_link"]);

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  rosterName: text("roster_name"),
  role: memberRole("role").notNull().default("member"),
  status: memberStatus("status").notNull().default("pending"),
  paymentRef: text("payment_ref").notNull().unique(),
  joinedAt: timestamp("joined_at", { withTimezone: true }),
  leftAt: timestamp("left_at", { withTimezone: true }),
  globalMute: boolean("global_mute").notNull().default(false),
});

export const invite = pgTable("invite", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  createdBy: text("created_by")
    .notNull()
    .references(() => member.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  maxUses: integer("max_uses").notNull(),
  uses: integer("uses").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const joinRequest = pgTable("join_request", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => member.id),
  via: joinVia("via").notNull(),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  before: text("before"),
  after: text("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    key: text("key").notNull(),
    actorId: text("actor_id").notNull(),
    route: text("route").notNull(),
    responseHash: text("response_hash"),
    responseBody: text("response_body"),
    responseStatus: integer("response_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_record_pk").on(t.key, t.actorId, t.route)],
);
