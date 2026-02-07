ALTER TABLE "postmark_sendings" ADD COLUMN "brand_id" text;--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN "campaign_id" text;--> statement-breakpoint
CREATE INDEX "idx_sendings_brand" ON "postmark_sendings" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "idx_sendings_app" ON "postmark_sendings" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_sendings_campaign" ON "postmark_sendings" USING btree ("campaign_id");