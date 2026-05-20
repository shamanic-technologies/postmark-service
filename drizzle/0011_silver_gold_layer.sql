-- Silver/Gold layering for stats — replaces query-time JS aggregation.

-- Composite index for slug-only filters (kept even alongside silver, useful for legacy backfill scans).
CREATE INDEX IF NOT EXISTS "idx_sendings_feature_created" ON "postmark_sendings" ("feature_slug", "created_at" DESC);--> statement-breakpoint

-- Silver: materialized Layer 2 status per message.
CREATE TABLE IF NOT EXISTS "postmark_messages" (
  "message_id" uuid PRIMARY KEY,
  "to_email" text NOT NULL,
  "from_email" text,
  "subject" text,
  "org_id" text,
  "user_id" text,
  "run_id" text,
  "campaign_id" text,
  "brand_ids" text[],
  "feature_slug" text,
  "workflow_slug" text,
  "lead_id" text,
  "submitted_at" timestamptz,
  "error_code" integer,
  "contacted" boolean NOT NULL DEFAULT false,
  "sent" boolean NOT NULL DEFAULT false,
  "delivered" boolean NOT NULL DEFAULT false,
  "opened" boolean NOT NULL DEFAULT false,
  "clicked" boolean NOT NULL DEFAULT false,
  "bounced" boolean NOT NULL DEFAULT false,
  "unsubscribed" boolean NOT NULL DEFAULT false,
  "last_delivered_at" timestamptz,
  "source_attribution" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_rebuilt_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_messages_org" ON "postmark_messages" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_org_campaign" ON "postmark_messages" ("org_id", "campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_run" ON "postmark_messages" ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_campaign" ON "postmark_messages" ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_brand_ids" ON "postmark_messages" USING gin ("brand_ids");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_workflow" ON "postmark_messages" ("workflow_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_feature_created" ON "postmark_messages" ("feature_slug", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_to_email" ON "postmark_messages" ("to_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_lead" ON "postmark_messages" ("lead_id");--> statement-breakpoint

-- Gold: daily rollup for public leaderboard / cross-org aggregates.
CREATE TABLE IF NOT EXISTS "postmark_stats_daily" (
  "feature_slug" text NOT NULL,
  "group_dim" text NOT NULL,
  "group_key" text NOT NULL,
  "day" date NOT NULL,
  "sent" integer NOT NULL DEFAULT 0,
  "delivered" integer NOT NULL DEFAULT 0,
  "opened" integer NOT NULL DEFAULT 0,
  "clicked" integer NOT NULL DEFAULT 0,
  "bounced" integer NOT NULL DEFAULT 0,
  "recipients" integer NOT NULL DEFAULT 0,
  "refreshed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("feature_slug", "group_dim", "group_key", "day")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_stats_daily_feature_day" ON "postmark_stats_daily" ("feature_slug", "day" DESC);
