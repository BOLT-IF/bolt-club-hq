CREATE TYPE "public"."poll_results_visibility" AS ENUM('always', 'after_vote', 'after_close', 'admins');--> statement-breakpoint
ALTER TABLE "poll_vote" DROP CONSTRAINT "poll_vote_poll_id_member_id_pk";--> statement-breakpoint
ALTER TABLE "poll_vote" ADD CONSTRAINT "poll_vote_poll_id_member_id_option_id_pk" PRIMARY KEY("poll_id","member_id","option_id");--> statement-breakpoint
ALTER TABLE "poll" ADD COLUMN "multi_choice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poll" ADD COLUMN "anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poll" ADD COLUMN "results_visibility" "poll_results_visibility" DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "poll" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;