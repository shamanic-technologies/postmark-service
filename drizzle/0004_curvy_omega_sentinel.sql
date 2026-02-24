ALTER TABLE "postmark_sendings" ADD COLUMN "lead_id" text;--> statement-breakpoint
CREATE INDEX "idx_sendings_lead" ON "postmark_sendings" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_sendings_campaign_email" ON "postmark_sendings" USING btree ("campaign_id","to_email");