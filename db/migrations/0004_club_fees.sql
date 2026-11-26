CREATE TYPE "public"."term_season" AS ENUM('fall', 'spring');--> statement-breakpoint
CREATE TYPE "public"."club_fee_kind" AS ENUM('charged', 'external_fall_paid', 'exempt');--> statement-breakpoint
CREATE TYPE "public"."club_fee_season" AS ENUM('fall', 'spring');--> statement-breakpoint
ALTER TYPE "public"."ledger_reason" ADD VALUE 'club_fee' BEFORE 'manual';--> statement-breakpoint
CREATE TABLE "club_fee" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"club_year" integer NOT NULL,
	"season" "club_fee_season" NOT NULL,
	"kind" "club_fee_kind" NOT NULL,
	"amount_sek" integer NOT NULL,
	"ledger_entry_id" text,
	"note" text DEFAULT '' NOT NULL,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "club_fee_fall_sek" integer DEFAULT 160 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "club_fee_spring_sek" integer DEFAULT 85 NOT NULL;--> statement-breakpoint
ALTER TABLE "term" ADD COLUMN "season" "term_season";--> statement-breakpoint
ALTER TABLE "term" ADD COLUMN "club_year" integer;--> statement-breakpoint
ALTER TABLE "club_fee" ADD CONSTRAINT "club_fee_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_fee" ADD CONSTRAINT "club_fee_ledger_entry_id_ledger_entry_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_fee" ADD CONSTRAINT "club_fee_recorded_by_member_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;