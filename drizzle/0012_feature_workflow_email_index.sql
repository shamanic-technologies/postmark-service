-- Covering index for the cross-org leaderboard query shape:
--   WHERE feature_slug IN (...) GROUP BY workflow_slug
--   + 13 aggregates (7x COUNT(DISTINCT to_email) FILTER (...) + 6x COUNT(*) FILTER (...))
--
-- Keys (feature_slug, workflow_slug, to_email) cover:
--   - WHERE feature_slug IN (...): leading-column scan
--   - GROUP BY workflow_slug: ordered GroupAggregate (no hash, no sort)
--   - COUNT(DISTINCT to_email): sorted-distinct per group (single pass)
--
-- INCLUDE columns are the boolean filter predicates — letting Postgres
-- satisfy COUNT(*) FILTER (WHERE <bool>) and COUNT(DISTINCT to_email) FILTER (WHERE <bool>)
-- via index-only scan (no heap fetch).
--
-- Without this, the query falls back to seq scan + hash agg and times out on Neon
-- (DrizzleQueryError: Failed query: ... ETIMEDOUT).
CREATE INDEX IF NOT EXISTS "idx_messages_feature_workflow_email"
  ON "postmark_messages" ("feature_slug", "workflow_slug", "to_email")
  INCLUDE ("contacted", "sent", "delivered", "opened", "clicked", "bounced", "unsubscribed");
