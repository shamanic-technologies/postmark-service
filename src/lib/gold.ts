import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Refresh the gold rollup `postmark_stats_daily` for the trailing window.
 *
 * For each (feature_slug, day) in the window, computes counts grouped by:
 *   - group_dim="total"          (one row per (feature_slug, day))
 *   - group_dim="workflow_slug"  (one row per (feature_slug, workflow_slug, day))
 *   - group_dim="brand_id"       (one row per (feature_slug, brand_id, day), unnested)
 *
 * Counts: sent / delivered / opened / clicked / bounced are counts of distinct messages
 * (rows in postmark_messages with the respective boolean true). `recipients` counts
 * distinct to_email — this is the leaderboard's "unique recipients" metric.
 *
 * Idempotent: DELETE the window rows then INSERT fresh. Refresh frequency (5min) bounds
 * the maximum staleness the leaderboard exhibits.
 */
export async function refreshStatsDaily({ windowDays = 7 }: { windowDays?: number } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    // Wipe the trailing window so a deletion in silver is reflected in gold.
    await tx.execute(sql`
      DELETE FROM "postmark_stats_daily"
      WHERE "day" >= (CURRENT_DATE - (${windowDays}::int - 1))
    `);

    // group_dim = total (one row per feature_slug, day)
    await tx.execute(sql`
      INSERT INTO "postmark_stats_daily" (
        "feature_slug", "group_dim", "group_key", "day",
        "sent", "delivered", "opened", "clicked", "bounced", "recipients", "refreshed_at"
      )
      SELECT
        "feature_slug",
        'total' AS group_dim,
        '' AS group_key,
        ("created_at" AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) FILTER (WHERE "sent")::int,
        COUNT(*) FILTER (WHERE "delivered")::int,
        COUNT(*) FILTER (WHERE "opened")::int,
        COUNT(*) FILTER (WHERE "clicked")::int,
        COUNT(*) FILTER (WHERE "bounced")::int,
        COUNT(DISTINCT "to_email")::int,
        now()
      FROM "postmark_messages"
      WHERE "feature_slug" IS NOT NULL
        AND "created_at" >= (CURRENT_DATE - (${windowDays}::int - 1))
      GROUP BY "feature_slug", ("created_at" AT TIME ZONE 'UTC')::date
    `);

    // group_dim = workflow_slug
    await tx.execute(sql`
      INSERT INTO "postmark_stats_daily" (
        "feature_slug", "group_dim", "group_key", "day",
        "sent", "delivered", "opened", "clicked", "bounced", "recipients", "refreshed_at"
      )
      SELECT
        "feature_slug",
        'workflow_slug' AS group_dim,
        "workflow_slug" AS group_key,
        ("created_at" AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) FILTER (WHERE "sent")::int,
        COUNT(*) FILTER (WHERE "delivered")::int,
        COUNT(*) FILTER (WHERE "opened")::int,
        COUNT(*) FILTER (WHERE "clicked")::int,
        COUNT(*) FILTER (WHERE "bounced")::int,
        COUNT(DISTINCT "to_email")::int,
        now()
      FROM "postmark_messages"
      WHERE "feature_slug" IS NOT NULL
        AND "workflow_slug" IS NOT NULL
        AND "created_at" >= (CURRENT_DATE - (${windowDays}::int - 1))
      GROUP BY "feature_slug", "workflow_slug", ("created_at" AT TIME ZONE 'UTC')::date
    `);

    // group_dim = brand_id (unnest the array; a single message can contribute to multiple brands)
    await tx.execute(sql`
      INSERT INTO "postmark_stats_daily" (
        "feature_slug", "group_dim", "group_key", "day",
        "sent", "delivered", "opened", "clicked", "bounced", "recipients", "refreshed_at"
      )
      SELECT
        m."feature_slug",
        'brand_id' AS group_dim,
        b.brand_id AS group_key,
        (m."created_at" AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) FILTER (WHERE m."sent")::int,
        COUNT(*) FILTER (WHERE m."delivered")::int,
        COUNT(*) FILTER (WHERE m."opened")::int,
        COUNT(*) FILTER (WHERE m."clicked")::int,
        COUNT(*) FILTER (WHERE m."bounced")::int,
        COUNT(DISTINCT m."to_email")::int,
        now()
      FROM "postmark_messages" m
      CROSS JOIN LATERAL unnest(m."brand_ids") AS b(brand_id)
      WHERE m."feature_slug" IS NOT NULL
        AND m."created_at" >= (CURRENT_DATE - (${windowDays}::int - 1))
      GROUP BY m."feature_slug", b.brand_id, (m."created_at" AT TIME ZONE 'UTC')::date
    `);
  });
}
