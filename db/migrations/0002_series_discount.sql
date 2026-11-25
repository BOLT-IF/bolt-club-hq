CREATE TABLE "series_discount_eligible" (
	"series_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "series_discount_eligible_series_id_member_id_pk" PRIMARY KEY("series_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "discounted_pass_price" integer;--> statement-breakpoint
ALTER TABLE "series_discount_eligible" ADD CONSTRAINT "series_discount_eligible_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_discount_eligible" ADD CONSTRAINT "series_discount_eligible_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;