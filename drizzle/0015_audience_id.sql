-- Add per-audience attribution (x-audience-id) to bronze sendings + silver messages.
--
-- The send path already forwards x-audience-id to runs-service for cost attribution
-- (commit 1113e95); this persists it on the engagement record at recipient grain so
-- GET /orgs/stats + /internal/stats can filter + groupBy audienceId, mirroring
-- instantly-service's contract (broadcast channel). See issue #160.
--
-- All nullable, no default → metadata-only ADD COLUMN (instant, no table rewrite),
-- boot-safe on the auto-migrate path. Idempotent via IF NOT EXISTS.
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "audience_id" text;--> statement-breakpoint
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "audience_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_audience" ON "postmark_sendings" ("audience_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_audience" ON "postmark_messages" ("audience_id");
