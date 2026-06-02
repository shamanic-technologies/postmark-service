/**
 * One-shot backfill: scan all postmark_sendings (bronze) and (re)build
 * postmark_messages (silver).
 *
 * Idempotent — safe to run multiple times. Pages bronze in batches and calls
 * upsertSilver per message.
 *
 * Run on Railway as a one-off:
 *   railway run npx tsx scripts/backfill-silver.ts
 *
 * Or locally:
 *   npx tsx scripts/backfill-silver.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { upsertSilver } from "../src/lib/silver";

const BATCH_SIZE = 500;

async function main() {
  const start = Date.now();
  let processed = 0;
  let failed = 0;
  let cursorCreatedAt: string | null = null;

  console.log("[backfill-silver] starting full silver rebuild");

  // Paginate by (created_at, message_id) — stable ordering, no offset cost.
  while (true) {
    const where = cursorCreatedAt
      ? sql`"message_id" IS NOT NULL AND "created_at" > ${cursorCreatedAt}::timestamptz`
      : sql`"message_id" IS NOT NULL`;

    const { rows } = await db.execute<{ message_id: string; created_at: string }>(sql`
      SELECT "message_id", "created_at"
      FROM "postmark_sendings"
      WHERE ${where}
      ORDER BY "created_at" ASC
      LIMIT ${BATCH_SIZE}
    `);

    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        await upsertSilver(row.message_id);
        processed++;
      } catch (err: any) {
        failed++;
        console.error(`[backfill-silver] upsertSilver failed for ${row.message_id}: ${err.message}`);
      }
    }

    cursorCreatedAt = rows[rows.length - 1].created_at;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `[backfill-silver] processed=${processed} failed=${failed} elapsed=${elapsed}s cursor=${cursorCreatedAt}`
    );
  }

  console.log(
    `[backfill-silver] DONE — processed=${processed} failed=${failed} totalSeconds=${Math.round((Date.now() - start) / 1000)}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-silver] fatal error:", err);
  process.exit(1);
});
