-- Which provider carried a send (SES-PLATFORM-SENDS-1119, owner 2026-11-19).
--
-- provider            = 'postmark' (every row before this migration, and every send
--                       not moved) | 'ses' (our own product mail from @distribute.you
--                       on the platform key, see src/lib/send-transport.ts). Also
--                       picks the cost name the run declares (postmark-email-send |
--                       ses-email-send), so the catch-up settles the right one.
-- provider_message_id = SES's own MessageId (the delivered Message-ID header is
--                       <id@email.amazonses.com>). message_id stays OUR uuid, minted
--                       for an SES send, so every uuid read (silver, /internal/status)
--                       keeps working. NULL for Postmark: its MessageID is message_id.
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'postmark';
--> statement-breakpoint
ALTER TABLE "postmark_sendings" ADD COLUMN IF NOT EXISTS "provider_message_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sendings_provider_message_id" ON "postmark_sendings" ("provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;
