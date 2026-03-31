-- Add brand_ids array column
ALTER TABLE "postmark_sendings" ADD COLUMN "brand_ids" text[];--> statement-breakpoint

-- Migrate existing data: wrap single brand_id into array
UPDATE "postmark_sendings" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;--> statement-breakpoint

-- Drop old btree index
DROP INDEX IF EXISTS "idx_sendings_brand";--> statement-breakpoint

-- Create GIN index for array queries
CREATE INDEX "idx_sendings_brand_ids" ON "postmark_sendings" USING gin ("brand_ids");--> statement-breakpoint

-- Drop old column
ALTER TABLE "postmark_sendings" DROP COLUMN IF EXISTS "brand_id";
