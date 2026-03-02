ALTER TABLE "orgs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks_runs_costs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "orgs" CASCADE;--> statement-breakpoint
DROP TABLE "tasks" CASCADE;--> statement-breakpoint
DROP TABLE "tasks_runs" CASCADE;--> statement-breakpoint
DROP TABLE "tasks_runs_costs" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
DROP INDEX "idx_sendings_app";--> statement-breakpoint
ALTER TABLE "postmark_sendings" DROP COLUMN "app_id";