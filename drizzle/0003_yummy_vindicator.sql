ALTER TABLE "postmark_sendings" ADD COLUMN "workflow_name" text;--> statement-breakpoint
CREATE INDEX "idx_sendings_workflow" ON "postmark_sendings" USING btree ("workflow_name");