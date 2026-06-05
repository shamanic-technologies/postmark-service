-- Add per-event first-occurrence (MIN) timestamp columns to the silver table.
--
-- Mirror of last_delivered_at (MAX). Only the genuinely-non-derivable events get
-- a column; firstContacted/Sent/Delivered are derived at read from
-- submitted_at / created_at / last_delivered_at. first_opened_at carries the
-- click-implication baked in (open ?? click) — see recomputeLayer2.
--
-- All nullable, no default → metadata-only ADD COLUMN (instant, no table rewrite),
-- boot-safe on the auto-migrate path. Idempotent via IF NOT EXISTS.
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "first_bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "postmark_messages" ADD COLUMN IF NOT EXISTS "first_unsubscribed_at" timestamp with time zone;
