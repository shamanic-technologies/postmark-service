CREATE TABLE IF NOT EXISTS "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_clerk_org_id_unique" UNIQUE("clerk_org_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_bounces" (
	"id" bigint PRIMARY KEY NOT NULL,
	"record_type" text,
	"type" text,
	"type_code" integer,
	"name" text,
	"tag" text,
	"message_id" uuid,
	"server_id" integer,
	"description" text,
	"details" text,
	"email" text,
	"from_address" text,
	"bounced_at" timestamp with time zone,
	"dump_available" boolean,
	"inactive" boolean,
	"can_activate" boolean,
	"subject" text,
	"content" text,
	"message_stream" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"record_type" text,
	"server_id" integer,
	"message_stream" text,
	"recipient" text,
	"tag" text,
	"delivered_at" timestamp with time zone,
	"details" text,
	"metadata" jsonb,
	"headers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postmark_deliveries_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_link_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type" text,
	"message_stream" text,
	"metadata" jsonb,
	"recipient" text,
	"message_id" uuid,
	"received_at" timestamp with time zone,
	"platform" text,
	"click_location" text,
	"original_link" text,
	"tag" text,
	"user_agent" text,
	"os" jsonb,
	"client" jsonb,
	"geo" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type" text,
	"message_stream" text,
	"metadata" jsonb,
	"first_open" boolean,
	"recipient" text,
	"message_id" uuid,
	"received_at" timestamp with time zone,
	"platform" text,
	"read_seconds" integer,
	"tag" text,
	"user_agent" text,
	"os" jsonb,
	"client" jsonb,
	"geo" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_sendings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"to_email" text NOT NULL,
	"from_email" text NOT NULL,
	"subject" text,
	"tag" text,
	"message_stream" text,
	"error_code" integer,
	"message" text,
	"submitted_at" timestamp with time zone,
	"org_id" text,
	"campaign_run_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postmark_sendings_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_spam_complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type" text,
	"message_stream" text,
	"metadata" jsonb,
	"message_id" uuid,
	"server_id" integer,
	"tag" text,
	"email" text,
	"from_address" text,
	"bounced_at" timestamp with time zone,
	"subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "postmark_subscription_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_type" text,
	"message_stream" text,
	"metadata" jsonb,
	"message_id" uuid,
	"server_id" integer,
	"tag" text,
	"recipient" text,
	"origin" text,
	"suppress_sending" boolean,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks_runs_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_run_id" uuid NOT NULL,
	"cost_name" text NOT NULL,
	"units" integer NOT NULL,
	"cost_per_unit_in_usd_cents" numeric(12, 10) NOT NULL,
	"total_cost_in_usd_cents" numeric(12, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tasks_runs" ADD CONSTRAINT "tasks_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tasks_runs_costs" ADD CONSTRAINT "tasks_runs_costs_task_run_id_tasks_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."tasks_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_clerk_id" ON "orgs" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_bounces_message_id" ON "postmark_bounces" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_deliveries_message_id" ON "postmark_deliveries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_link_clicks_message_id" ON "postmark_link_clicks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_openings_message_id" ON "postmark_openings" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sendings_message_id" ON "postmark_sendings" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_org" ON "postmark_sendings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sendings_campaign_run" ON "postmark_sendings" USING btree ("campaign_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_spam_complaints_message_id" ON "postmark_spam_complaints" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_changes_message_id" ON "postmark_subscription_changes" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_task" ON "tasks_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_org" ON "tasks_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_status" ON "tasks_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_costs_run" ON "tasks_runs_costs" USING btree ("task_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_runs_costs_name" ON "tasks_runs_costs" USING btree ("cost_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_clerk_id" ON "users" USING btree ("clerk_user_id");
