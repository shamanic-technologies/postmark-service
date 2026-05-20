/**
 * Backfill bronze event tables from Postmark API for sendings that have no events
 * in our DB (e.g. webhook URL was configured after the sends, so Postmark never
 * POSTed events to us).
 *
 * For each postmark_sendings row, calls Postmark API:
 *   GET /messages/outbound/<id>/details   → MessageEvents (Delivered, Opened, Bounced)
 *   GET /clicks/<id>                      → Click events
 *
 * Then INSERTs into bronze tables and calls upsertSilver(messageId) to rebuild the
 * silver row. Idempotent — re-running with same Postmark state produces same result
 * (ON CONFLICT DO NOTHING on bronze unique keys; silver UPSERTs).
 *
 * Run on Railway one-off (so internal hostnames work):
 *   railway run npx tsx scripts/backfill-from-postmark-api.ts
 *
 * Or locally with public key-service URL + prod DB URL:
 *   KEY_SERVICE_URL=https://key.distribute.you \
 *   KEY_SERVICE_API_KEY=<from-railway-env> \
 *   POSTMARK_SERVICE_DATABASE_URL=postgresql://... \
 *   npx tsx scripts/backfill-from-postmark-api.ts
 *
 * Flags:
 *   --org-id=<uuid>        restrict to one org (debugging)
 *   --since=YYYY-MM-DD     only sendings created on or after this date
 *   --dry-run              fetch from Postmark + log counts, do NOT insert
 */
import * as dotenv from "dotenv";
dotenv.config();

import { sql } from "drizzle-orm";
import { ServerClient } from "postmark";
import { db } from "../src/db";
import {
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
} from "../src/db/schema";
import { upsertSilver } from "../src/lib/silver";
import { getOrgKey } from "../src/lib/key-client";

const args = process.argv.slice(2);
const ORG_FILTER = args.find((a) => a.startsWith("--org-id="))?.split("=")[1];
const SINCE = args.find((a) => a.startsWith("--since="))?.split("=")[1];
const DRY_RUN = args.includes("--dry-run");

interface SendingRow {
  message_id: string;
  org_id: string | null;
  user_id: string | null;
  to_email: string;
  created_at: string;
}

interface PostmarkMessageDetails {
  MessageID: string;
  ReceivedAt: string;
  MessageEvents?: Array<{
    Recipient?: string;
    Type: "Delivered" | "Opened" | "Bounced" | "LinkClicked" | "SubscriptionChanged" | "Transient" | "SpamComplaint";
    ReceivedAt: string;
    Details?: Record<string, unknown>;
  }>;
}

interface PostmarkClickEvent {
  MessageID: string;
  Recipient: string;
  ReceivedAt: string;
  Platform?: string;
  ClickLocation?: string;
  OriginalLink?: string;
  Tag?: string;
  UserAgent?: string;
  Geo?: unknown;
}

interface PostmarkOpenEvent {
  MessageID: string;
  Recipient: string;
  ReceivedAt: string;
  Platform?: string;
  ReadSeconds?: number;
  Tag?: string;
  UserAgent?: string;
  FirstOpen?: boolean;
  OS?: unknown;
  Client?: unknown;
  Geo?: unknown;
}

const tokenCache = new Map<string, string>();

async function resolveToken(orgId: string, userId: string): Promise<string | null> {
  if (tokenCache.has(orgId)) return tokenCache.get(orgId)!;
  try {
    const { key } = await getOrgKey(
      orgId,
      userId,
      "postmark",
      { method: "GET", path: "/scripts/backfill-from-postmark-api" },
    );
    tokenCache.set(orgId, key);
    return key;
  } catch (err: any) {
    console.warn(`[backfill-postmark-api] cannot resolve postmark key for org=${orgId}: ${err.message}`);
    return null;
  }
}

async function pmFetch<T>(token: string, path: string): Promise<T | null> {
  const res = await fetch(`https://api.postmarkapp.com${path}`, {
    headers: { Accept: "application/json", "X-Postmark-Server-Token": token },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Postmark ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function ingestEventsForMessage(
  token: string,
  sending: SendingRow,
): Promise<{ deliveries: number; opens: number; clicks: number; bounces: number }> {
  const counts = { deliveries: 0, opens: 0, clicks: 0, bounces: 0 };

  const details = await pmFetch<PostmarkMessageDetails>(token, `/messages/outbound/${sending.message_id}/details`);
  if (!details) return counts;

  const events = details.MessageEvents ?? [];

  for (const ev of events) {
    const when = new Date(ev.ReceivedAt);
    const recipient = ev.Recipient ?? sending.to_email;

    if (ev.Type === "Delivered") {
      if (!DRY_RUN) {
        await db
          .insert(postmarkDeliveries)
          .values({
            messageId: sending.message_id,
            recordType: "Delivery",
            recipient,
            deliveredAt: when,
            details: typeof ev.Details === "object" ? JSON.stringify(ev.Details) : undefined,
            metadata: (ev.Details ?? null) as any,
          })
          .onConflictDoNothing();
      }
      counts.deliveries++;
    } else if (ev.Type === "Bounced") {
      if (!DRY_RUN) {
        const det = (ev.Details ?? {}) as Record<string, any>;
        await db
          .insert(postmarkBounces)
          .values({
            id: Number(det.BounceID ?? `${Date.now()}${counts.bounces}`),
            messageId: sending.message_id,
            recordType: "Bounce",
            type: det.Type,
            typeCode: det.TypeCode,
            name: det.Name,
            description: det.Description,
            details: det.Details,
            email: recipient,
            bouncedAt: when,
            metadata: ev.Details as any,
          })
          .onConflictDoNothing();
      }
      counts.bounces++;
    }
    // Opened is handled via dedicated endpoint below for richer columns.
  }

  // Opens — Postmark accepts /messages/outbound/opens/<messageID>?count=500&offset=0 (path + required pagination).
  const opensRes = await pmFetch<{ Opens: PostmarkOpenEvent[] }>(
    token,
    `/messages/outbound/opens/${sending.message_id}?count=500&offset=0`,
  );
  for (const op of opensRes?.Opens ?? []) {
    if (DRY_RUN) {
      counts.opens++;
      continue;
    }
    await db.insert(postmarkOpenings).values({
      messageId: op.MessageID,
      recordType: "Open",
      recipient: op.Recipient,
      receivedAt: new Date(op.ReceivedAt),
      platform: op.Platform,
      readSeconds: op.ReadSeconds,
      tag: op.Tag,
      userAgent: op.UserAgent,
      firstOpen: op.FirstOpen,
      os: op.OS as any,
      client: op.Client as any,
      geo: op.Geo as any,
    });
    counts.opens++;
  }

  // Clicks
  const clicksRes = await pmFetch<{ Clicks: PostmarkClickEvent[] }>(
    token,
    `/messages/outbound/clicks/${sending.message_id}?count=500&offset=0`,
  );
  for (const click of clicksRes?.Clicks ?? []) {
    if (DRY_RUN) {
      counts.clicks++;
      continue;
    }
    await db.insert(postmarkLinkClicks).values({
      messageId: click.MessageID,
      recordType: "Click",
      recipient: click.Recipient,
      receivedAt: new Date(click.ReceivedAt),
      platform: click.Platform,
      clickLocation: click.ClickLocation,
      originalLink: click.OriginalLink,
      tag: click.Tag,
      userAgent: click.UserAgent,
      geo: click.Geo as any,
    });
    counts.clicks++;
  }

  if (!DRY_RUN) await upsertSilver(sending.message_id);

  return counts;
}

async function main() {
  const startedAt = Date.now();
  const conditions: any[] = [sql`message_id IS NOT NULL AND org_id IS NOT NULL`];
  if (ORG_FILTER) conditions.push(sql`org_id = ${ORG_FILTER}`);
  if (SINCE) conditions.push(sql`created_at >= ${SINCE}::timestamptz`);
  const where = sql.join(conditions, sql` AND `);

  const { rows: sendings } = await db.execute<SendingRow>(sql`
    SELECT message_id::text, org_id, user_id, to_email, created_at::text
    FROM postmark_sendings
    WHERE ${where}
    ORDER BY created_at ASC
  `);

  console.log(`[backfill-postmark-api] scanning ${sendings.length} sendings  dry_run=${DRY_RUN}`);

  const totals = { deliveries: 0, opens: 0, clicks: 0, bounces: 0 };
  const perOrg = new Map<string, number>();
  let processed = 0;
  let skipped_no_token = 0;
  let failed = 0;

  for (const s of sendings) {
    perOrg.set(s.org_id!, (perOrg.get(s.org_id!) ?? 0) + 1);
    const token = await resolveToken(s.org_id!, s.user_id ?? "backfill-script");
    if (!token) {
      skipped_no_token++;
      continue;
    }
    try {
      const c = await ingestEventsForMessage(token, s);
      totals.deliveries += c.deliveries;
      totals.opens += c.opens;
      totals.clicks += c.clicks;
      totals.bounces += c.bounces;
      processed++;
      if (processed % 25 === 0) {
        console.log(`[backfill-postmark-api] processed=${processed}/${sendings.length}  totals=${JSON.stringify(totals)}`);
      }
    } catch (err: any) {
      failed++;
      console.error(`[backfill-postmark-api] ingest failed for msg=${s.message_id} org=${s.org_id}: ${err.message}`);
    }
  }

  console.log(`[backfill-postmark-api] DONE  elapsed=${Math.round((Date.now() - startedAt) / 1000)}s  processed=${processed}  failed=${failed}  skipped_no_token=${skipped_no_token}`);
  console.log(`[backfill-postmark-api] totals: ${JSON.stringify(totals)}`);
  console.log(`[backfill-postmark-api] sendings-per-org: ${JSON.stringify(Object.fromEntries(perOrg))}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-postmark-api] fatal:", err);
  process.exit(1);
});
