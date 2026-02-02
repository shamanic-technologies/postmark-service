ALTER TABLE "postmark_sendings" RENAME COLUMN "campaign_run_id" TO "run_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sendings_campaign_run";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_run" ON "postmark_sendings" USING btree ("run_id");
