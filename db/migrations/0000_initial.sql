CREATE TYPE "public"."join_via" AS ENUM('invite', 'event_link', 'series_link');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('pending', 'active', 'inactive', 'erased');--> statement-breakpoint
CREATE TYPE "public"."allocation_mode" AS ENUM('tiered', 'instant');--> statement-breakpoint
CREATE TYPE "public"."attendance" AS ENUM('unknown', 'attended', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('series', 'member_oneoff', 'admin_oneoff');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('scheduled', 'closed', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."pass_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."rsvp_status" AS ENUM('requested', 'confirmed', 'waitlisted', 'offered', 'cancelled', 'late_cancelled');--> statement-breakpoint
CREATE TYPE "public"."series_format" AS ENUM('MD', 'WD', 'XD', 'mixed', 'open');--> statement-breakpoint
CREATE TYPE "public"."term_status" AS ENUM('draft', 'open_for_passes', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('charge', 'payment', 'reversal', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('pass', 'adhoc', 'guest', 'manual', 'payment', 'waiver', 'revocation', 'opening_balance');--> statement-breakpoint
CREATE TYPE "public"."payment_claim_status" AS ENUM('pending', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('queued', 'sent', 'failed', 'deferred');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" text,
	"after" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"key" text NOT NULL,
	"actor_id" text NOT NULL,
	"route" text NOT NULL,
	"response_hash" text,
	"response_body" text,
	"response_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "join_request" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"via" "join_via" NOT NULL,
	"source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"roster_name" text,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"status" "member_status" DEFAULT 'pending' NOT NULL,
	"payment_ref" text NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"global_mute" boolean DEFAULT false NOT NULL,
	CONSTRAINT "member_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "member_payment_ref_unique" UNIQUE("payment_ref")
);
--> statement-breakpoint
CREATE TABLE "club_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"club_name" text NOT NULL,
	"bank_details" text,
	"payment_instructions" text,
	"quiet_hours" jsonb,
	"pass_unpaid_revoke_days" integer DEFAULT 21 NOT NULL,
	"auto_promote_cutoff_min" integer DEFAULT 180 NOT NULL,
	"defaults" jsonb,
	"accounting_account_codes" jsonb,
	"roster_app_url" text
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text,
	"kind" "event_kind" NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"format" "series_format" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location" text,
	"capacity" integer NOT NULL,
	"adhoc_fee" integer NOT NULL,
	"max_guests_per_member" integer DEFAULT 0 NOT NULL,
	"rsvp_close_at" timestamp with time zone NOT NULL,
	"allocation_mode" "allocation_mode" NOT NULL,
	"status" "event_status" DEFAULT 'scheduled' NOT NULL,
	"share_slug" text NOT NULL,
	"closed_processed_at" timestamp with time zone,
	"material_change_at" timestamp with time zone,
	CONSTRAINT "event_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
CREATE TABLE "guest" (
	"id" text PRIMARY KEY NOT NULL,
	"rsvp_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "rsvp_status" NOT NULL,
	"tier" integer DEFAULT 3 NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"refilled" boolean DEFAULT false NOT NULL,
	"attendance" "attendance" DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pass" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"series_id" text NOT NULL,
	"price_charged" integer NOT NULL,
	"events_covered" integer NOT NULL,
	"status" "pass_status" DEFAULT 'active' NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"granted_by" text
);
--> statement-breakpoint
CREATE TABLE "rsvp" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"member_id" text NOT NULL,
	"status" "rsvp_status" NOT NULL,
	"tier" integer NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refilled" boolean DEFAULT false NOT NULL,
	"attendance" "attendance" DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"term_id" text NOT NULL,
	"name" text NOT NULL,
	"format" "series_format" NOT NULL,
	"level" text,
	"weekday" integer NOT NULL,
	"start_time" text NOT NULL,
	"duration_min" integer NOT NULL,
	"location" text,
	"capacity" integer NOT NULL,
	"pass_price" integer NOT NULL,
	"adhoc_fee" integer NOT NULL,
	"max_guests_default" integer DEFAULT 0 NOT NULL,
	"rsvp_close_offset_min" integer DEFAULT 1440 NOT NULL,
	"share_slug" text NOT NULL,
	"skip_dates" date[] DEFAULT '{}' NOT NULL,
	"skip_dates_locked" boolean DEFAULT false NOT NULL,
	"pass_cap" integer NOT NULL,
	CONSTRAINT "series_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
CREATE TABLE "series_captain" (
	"series_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "series_captain_series_id_member_id_pk" PRIMARY KEY("series_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "term" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "term_status" DEFAULT 'draft' NOT NULL,
	"cloned_from_term_id" text
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"amount_sek" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"event_id" text,
	"pass_id" text,
	"guest_id" text,
	"payment_claim_id" text,
	"reverses_entry_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"exported_at" timestamp with time zone,
	CONSTRAINT "ledger_entry_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payment_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"amount_sek" integer NOT NULL,
	"paid_on" timestamp with time zone NOT NULL,
	"note" text,
	"status" "payment_claim_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text
);
--> statement-breakpoint
CREATE TABLE "domain_event_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "notification_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "notification_pref" (
	"member_id" text NOT NULL,
	"category" text NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notification_pref_member_id_category_pk" PRIMARY KEY("member_id","category")
);
--> statement-breakpoint
CREATE TABLE "notification_send_log" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"category" text NOT NULL,
	"rule_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_push" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"status" "outbound_status" DEFAULT 'queued' NOT NULL,
	"not_before" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"created_by" text NOT NULL,
	"closes_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_option" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_id" text NOT NULL,
	"label" text NOT NULL,
	"image_key" text
);
--> statement-breakpoint
CREATE TABLE "poll_vote" (
	"poll_id" text NOT NULL,
	"option_id" text NOT NULL,
	"member_id" text NOT NULL,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_vote_poll_id_member_id_pk" PRIMARY KEY("poll_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reminder_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"params" jsonb NOT NULL,
	"min_interval_days" integer DEFAULT 1 NOT NULL,
	"template" text NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "scheduler_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_tick_at" timestamp with time zone,
	"last_tick_duration_ms" integer,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest" ADD CONSTRAINT "guest_rsvp_id_rsvp_id_fk" FOREIGN KEY ("rsvp_id") REFERENCES "public"."rsvp"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass" ADD CONSTRAINT "pass_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass" ADD CONSTRAINT "pass_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pass" ADD CONSTRAINT "pass_granted_by_member_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp" ADD CONSTRAINT "rsvp_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvp" ADD CONSTRAINT "rsvp_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_term_id_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_captain" ADD CONSTRAINT "series_captain_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_captain" ADD CONSTRAINT "series_captain_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_pass_id_pass_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."pass"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_guest_id_guest_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guest"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claim" ADD CONSTRAINT "payment_claim_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claim" ADD CONSTRAINT "payment_claim_decided_by_member_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_pref" ADD CONSTRAINT "notification_pref_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send_log" ADD CONSTRAINT "notification_send_log_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send_log" ADD CONSTRAINT "notification_send_log_rule_id_reminder_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."reminder_rule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_push" ADD CONSTRAINT "outbound_push_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll" ADD CONSTRAINT "poll_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_option" ADD CONSTRAINT "poll_option_poll_id_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."poll"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_poll_id_poll_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."poll"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_option_id_poll_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_option"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_rule" ADD CONSTRAINT "reminder_rule_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_record_pk" ON "idempotency_record" USING btree ("key","actor_id","route");--> statement-breakpoint
-- Append-only ledger (PLAN §5.2 invariant 1). Blocks UPDATE and DELETE. The only
-- allowed change is a one-time stamp of exported_at, with every other column unchanged.
CREATE OR REPLACE FUNCTION ledger_entry_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entry is append-only: DELETE is not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exported_at IS NULL AND NEW.exported_at IS NOT NULL
     AND (NEW.id, NEW.member_id, NEW.kind, NEW.amount_sek, NEW.reason, NEW.event_id, NEW.pass_id,
          NEW.guest_id, NEW.payment_claim_id, NEW.reverses_entry_id, NEW.note, NEW.created_by,
          NEW.created_at, NEW.idempotency_key)
       IS NOT DISTINCT FROM
         (OLD.id, OLD.member_id, OLD.kind, OLD.amount_sek, OLD.reason, OLD.event_id, OLD.pass_id,
          OLD.guest_id, OLD.payment_claim_id, OLD.reverses_entry_id, OLD.note, OLD.created_by,
          OLD.created_at, OLD.idempotency_key) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger_entry is append-only: UPDATE is not allowed except a one-time exported_at stamp' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();
