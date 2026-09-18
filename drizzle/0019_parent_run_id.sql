-- Record the caller's own run on every send, bronze and silver.
--
-- run_id holds the CHILD run this service mints per message, so a caller asking
-- "how did my operation go" with the run it is tracking matches no rows at all and
-- reads a well-formed zero. The parent of that child — the inbound x-run-id — was
-- already in hand at send time and thrown away; this column keeps it.
--
-- Indexed on both tables so the per-operation aggregate is an index scan whatever
-- the operation's message count.
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "parent_run_id" text;
--> statement-breakpoint
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "parent_run_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_parent_run" ON "postmark_sendings" ("parent_run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_parent_run" ON "postmark_messages" ("parent_run_id");
--> statement-breakpoint
-- Silver mirrors bronze. Rows sent before this migration carry NULL on both tables
-- until scripts/backfill-parent-run.ts resolves them from runs-service.
UPDATE "postmark_messages" m
   SET "parent_run_id" = s."parent_run_id"
  FROM "postmark_sendings" s
 WHERE s."message_id" = m."message_id"
   AND m."parent_run_id" IS NULL
   AND s."parent_run_id" IS NOT NULL;
