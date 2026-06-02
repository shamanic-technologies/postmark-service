-- Drop the gold rollup table postmark_stats_daily.
--
-- Removed because it had ZERO readers across the fleet: the cross-org feature
-- leaderboard is served live from silver (postmark_messages) via
-- GET /internal/stats (made fast by idx_messages_feature_workflow_email in 0012),
-- never from this table. The 5-minute refresh cron that maintained it kept the
-- Neon compute awake 24/7 (blocking scale-to-zero) while producing rows nobody read.
--
-- Idempotent: IF EXISTS + CASCADE (drops the dependent idx_stats_daily_feature_day).
DROP TABLE IF EXISTS "postmark_stats_daily" CASCADE;
