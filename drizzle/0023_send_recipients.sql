-- One send, several SES messages, billed per recipient (SES-BCC-1127, 2026-11-27).
--
-- provider_copy_message_ids = the OTHER SES MessageIds of a send split because SES
--                             refuses list management (unsubscribe) on a message with
--                             more than one recipient: the blind copy, extra To/Cc.
--                             Their events are recognised, never recorded on the
--                             send's silver row. NULL = one message.
-- recipient_count           = every address the send named (To + Cc + Bcc): the units
--                             its run's cost declares (both providers bill per
--                             recipient). NULL = 1 (rows before this migration).
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "provider_copy_message_ids" text[];
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "recipient_count" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_provider_copy_message_ids" ON "postmark_sendings" USING gin ("provider_copy_message_ids");
