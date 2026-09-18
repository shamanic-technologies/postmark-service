-- Mirror the send-time tag onto the silver row, and index it.
--
-- A caller that performs many sends as one logical operation gives every one of
-- those messages the same Postmark tag. Bronze (postmark_sendings) has carried
-- that tag since the first migration; silver never did, and every read endpoint
-- reads silver — so there was no way to name that operation as a set. The only
-- per-operation filter on the stats read was run_id, which here is the CHILD run
-- this service mints per send, not the caller's own run: a query keyed on the
-- caller's run matched nothing and answered a well-formed zero.
--
-- The backfill copies the tag from bronze for every silver row that has one, so
-- an operation that finished before this migration is readable too. It is
-- idempotent (only fills rows whose tag is still NULL) and re-runnable.
--
-- Nothing existing changes meaning: no other column, filter or index is touched.
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "tag" text;
--> statement-breakpoint
UPDATE "postmark_messages" m
SET "tag" = s."tag"
FROM "postmark_sendings" s
WHERE s."message_id" = m."message_id"
  AND m."tag" IS NULL
  AND s."tag" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_tag" ON "postmark_messages" ("tag");
