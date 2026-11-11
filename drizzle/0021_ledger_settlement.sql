-- A send answers its caller as soon as Postmark accepted it and its row is stored
-- (SIGNUP-EMAILS-1111). The run's cost + completion (runs-service) settle AFTER the
-- response, so the row records what is still owed to the ledger:
--
-- ledger_status       = what the send's run must become: 'completed' (the send went
--                       out: declare its cost, then complete) or 'failed' (Postmark
--                       refused it: fail the run). NULL = a row written before this
--                       migration, whose ledger settled inline.
-- ledger_cost_source  = the key that paid Postmark ('platform' | 'org'), the
--                       costSource of the cost row ('completed' only).
-- ledger_settled_at   = runs-service accepted the settlement. NULL with a status =
--                       still owed: retried by the catch-up sweep until it lands.
-- ledger_settle_error = runs-service refused it for good (4xx): logged, never retried.
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "ledger_status" text;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "ledger_cost_source" text;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "ledger_settled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "ledger_settle_error" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_ledger_pending" ON "postmark_sendings" ("created_at")
  WHERE "ledger_status" IS NOT NULL AND "ledger_settled_at" IS NULL AND "ledger_settle_error" IS NULL;
