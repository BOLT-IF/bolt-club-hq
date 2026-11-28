ALTER TABLE "event" ALTER COLUMN "format" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "series" ALTER COLUMN "format" SET DATA TYPE text;--> statement-breakpoint
UPDATE "event" SET "format" = CASE "format"
  WHEN 'MD' THEN 'Men''s Doubles'
  WHEN 'WD' THEN 'Women''s Doubles'
  WHEN 'XD' THEN 'Mixed Doubles'
  WHEN 'mixed' THEN 'Mixed Doubles'
  WHEN 'open' THEN 'Open'
  ELSE "format"
END;--> statement-breakpoint
UPDATE "series" SET "format" = CASE "format"
  WHEN 'MD' THEN 'Men''s Doubles'
  WHEN 'WD' THEN 'Women''s Doubles'
  WHEN 'XD' THEN 'Mixed Doubles'
  WHEN 'mixed' THEN 'Mixed Doubles'
  WHEN 'open' THEN 'Open'
  ELSE "format"
END;--> statement-breakpoint
DROP TYPE "public"."series_format";--> statement-breakpoint
CREATE TYPE "public"."series_format" AS ENUM('Men''s Doubles', 'Mixed Doubles', 'Women''s Doubles', 'Singles', 'Training', 'Open');--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "format" SET DATA TYPE "public"."series_format" USING "format"::"public"."series_format";--> statement-breakpoint
ALTER TABLE "series" ALTER COLUMN "format" SET DATA TYPE "public"."series_format" USING "format"::"public"."series_format";