ALTER TABLE "orgs" RENAME COLUMN "clerk_org_id" TO "org_id";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "clerk_user_id" TO "user_id";--> statement-breakpoint
DROP INDEX "idx_orgs_clerk_id";--> statement-breakpoint
DROP INDEX "idx_users_clerk_id";--> statement-breakpoint
ALTER TABLE "orgs" RENAME CONSTRAINT "orgs_clerk_org_id_unique" TO "orgs_org_id_unique";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_clerk_user_id_unique" TO "users_user_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_orgs_org_id" ON "orgs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_user_id" ON "users" USING btree ("user_id");
