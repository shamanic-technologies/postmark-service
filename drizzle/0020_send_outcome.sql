-- The outcome a send PRODUCED, declared to runs-service's production-cost ledger
-- (COST-ACCOUNTING-1023). A send to one person on a list or campaign produces
-- `message_sent` for that person; the caller names the person (outcome subject).
-- A send with no subject (a receipt, a code, a staff alert) declares nothing.
--
-- outcome_declared_at = runs-service accepted the declaration (recorded or
-- already_recorded). NULL with a subject = still owed: retried by the catch-up
-- sweep until it lands, so a failed declaration never blocks or loses the send.
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "outcome_subject_service" text;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "outcome_subject_id" text;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "consumed_outcome_keys" text[];
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "outcome_declared_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "outcome_declare_error" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_outcome_pending" ON "postmark_sendings" ("created_at")
  WHERE "outcome_subject_id" IS NOT NULL AND "outcome_declared_at" IS NULL AND "outcome_declare_error" IS NULL;
