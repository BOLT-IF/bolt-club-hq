CREATE TABLE "event_eligible_member" (
	"event_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "event_eligible_member_event_id_member_id_pk" PRIMARY KEY("event_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "audience_kind" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "audience_series_id" text;--> statement-breakpoint
ALTER TABLE "event_eligible_member" ADD CONSTRAINT "event_eligible_member_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_eligible_member" ADD CONSTRAINT "event_eligible_member_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_audience_series_id_series_id_fk" FOREIGN KEY ("audience_series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;