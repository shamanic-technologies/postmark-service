import { messageOf } from "../lib/db-error.js";
import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkMessages, postmarkSendings } from "../db/schema";
import { eq, inArray, and, arrayContains, sql, SQL, Param } from "drizzle-orm";
import { serializeStatusResults, GlobalFlags, StatusRow } from "../lib/status-results";
import { StatsQuerySchema, StatusRequestSchema } from "../schemas";

// ── Internal routes (API key only, no identity headers) ───────────────────────

const internalRouter = Router();

/**
 * Shape the silver row into the wire-format Layer 2 status object.
 * Identical to the legacy compute-at-read shape.
 */
function silverToStatus(row: {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: Date | null;
}) {
  return {
    contacted: row.contacted,
    sent: row.sent,
    delivered: row.delivered,
    opened: row.opened,
    clicked: row.clicked,
    replied: false,
    replyClassification: null as string | null,
    bounced: row.bounced,
    unsubscribed: row.unsubscribed,
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
  };
}

/**
 * GET /internal/status/:messageId
 * Get the Layer 2 status of an email by its Postmark message ID
 */
internalRouter.get("/status/:messageId", async (req: Request, res: Response) => {
  const { messageId } = req.params;

  if (!messageId) {
    return res.status(400).json({ error: "messageId is required" });
  }

  try {
    const [row] = await db
      .select()
      .from(postmarkMessages)
      .where(eq(postmarkMessages.messageId, messageId))
      .limit(1);

    if (!row) {
      return res.status(404).json({ error: "Message not found" });
    }

    // sending.id is on the bronze table; fetch it for backward-compat in the response shape.
    const [sending] = await db
      .select({ id: postmarkSendings.id })
      .from(postmarkSendings)
      .where(eq(postmarkSendings.messageId, messageId))
      .limit(1);

    res.json({
      messageId,
      sending: {
        id: sending?.id ?? "",
        to: row.toEmail,
        from: row.fromEmail,
        subject: row.subject,
        submittedAt: row.submittedAt,
        orgId: row.orgId,
        runId: row.runId,
      },
      status: silverToStatus(row),
    });
  } catch (error: any) {
    console.error("[postmark-service] Error getting message status:", error);
    res.status(500).json({
      error: "Failed to get message status",
      details: messageOf(error),
    });
  }
});

/**
 * GET /internal/status/by-org/:orgId
 * Get emails for an organization with Layer 2 status
 */
internalRouter.get("/status/by-org/:orgId", async (req: Request, res: Response) => {
  const { orgId } = req.params;
  const limitParam = req.query.limit ? parseInt(req.query.limit as string) : undefined;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is required" });
  }

  try {
    const query = db
      .select()
      .from(postmarkMessages)
      .where(eq(postmarkMessages.orgId, orgId))
      .orderBy(postmarkMessages.createdAt);

    const rows = limitParam ? await query.limit(limitParam) : await query;

    res.json({
      orgId,
      count: rows.length,
      emails: rows.map((r) => ({
        messageId: r.messageId,
        to: r.toEmail,
        subject: r.subject,
        submittedAt: r.submittedAt,
        status: silverToStatus(r),
      })),
    });
  } catch (error: any) {
    console.error("[postmark-service] Error getting org emails:", error);
    res.status(500).json({
      error: "Failed to get org emails",
      details: messageOf(error),
    });
  }
});

/**
 * GET /internal/status/by-run/:runId
 * Get emails for a specific run with Layer 2 status
 */
internalRouter.get("/status/by-run/:runId", async (req: Request, res: Response) => {
  const { runId } = req.params;

  if (!runId) {
    return res.status(400).json({ error: "runId is required" });
  }

  try {
    const rows = await db
      .select()
      .from(postmarkMessages)
      .where(eq(postmarkMessages.runId, runId))
      .orderBy(postmarkMessages.createdAt);

    res.json({
      runId,
      total: rows.length,
      emails: rows.map((r) => ({
        messageId: r.messageId,
        to: r.toEmail,
        subject: r.subject,
        submittedAt: r.submittedAt,
        status: silverToStatus(r),
      })),
    });
  } catch (error: any) {
    console.error("[postmark-service] Error getting run emails:", error);
    res.status(500).json({
      error: "Failed to get run emails",
      details: messageOf(error),
    });
  }
});

/**
 * GET /internal/stats
 * Same as /orgs/stats but only requires service API key (no identity headers).
 * Used by email-gateway for transactional stats aggregation.
 * Allows an unfiltered call → global cross-org aggregate (service-auth only).
 */
internalRouter.get("/stats", (req, res) => handleStats(req, res, { allowGlobal: true }));

/**
 * GET /internal/operations/:operationRunId/stats
 *
 * Aggregate outcomes for one logical send operation — every message this service
 * sent under the caller's own run — in a single request.
 *
 * Why this exists rather than ?runIds=: run_id on a message is the CHILD run this
 * service mints per send, so a caller filtering on the run IT is tracking matches
 * no rows and gets a well-formed all-zero answer back. An empty match and a real
 * zero were indistinguishable, so a consumer gating a decision on the numbers (the
 * mailing-list release self-halt) read a blind query as a healthy one.
 *
 * Here they are never confusable: an operation with no messages recorded under it
 * is a 404 carrying no stats at all, so there are no zeros to misread. A 200 always
 * describes messages that exist, and says how many it counted.
 *
 * Cost: one indexed aggregate (idx_messages_parent_run) whatever the operation's
 * size. Nothing is enumerated, no message id or child run leaves this service.
 */
internalRouter.get("/operations/:operationRunId/stats", async (req: Request, res: Response) => {
  const operationRunId = req.params.operationRunId;
  if (!operationRunId) {
    return res.status(400).json({ error: "operationRunId is required" });
  }

  try {
    const { rows } = await db.execute<
      AggregateRow & {
        messages_matched: number;
        recipients_matched: number;
        first_message_at: string | null;
        last_message_at: string | null;
      }
    >(sql`
      SELECT
        COUNT(*)::int AS messages_matched,
        COUNT(DISTINCT "to_email")::int AS recipients_matched,
        MIN(COALESCE("submitted_at", "created_at")) AS first_message_at,
        MAX(COALESCE("submitted_at", "created_at")) AS last_message_at,
        ${aggregateExprs()}
      FROM "postmark_messages"
      WHERE "parent_run_id" = ${operationRunId}
    `);

    const agg = rows[0];
    const messagesMatched = agg?.messages_matched ?? 0;

    // No silent zero: an operation this service has no messages for is reported as
    // such, with no stats block, so it cannot be read as "the operation is fine".
    if (messagesMatched === 0) {
      return res.status(404).json({
        error: "No messages are recorded under this operation",
        code: "OPERATION_NOT_FOUND",
        operationRunId,
        messagesMatched: 0,
      });
    }

    const toIso = (v: string | Date | null | undefined): string | null =>
      v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

    return res.json({
      operationRunId,
      messagesMatched,
      recipientsMatched: agg!.recipients_matched,
      firstMessageAt: toIso(agg!.first_message_at),
      lastMessageAt: toIso(agg!.last_message_at),
      recipientStats: buildRecipientStatsObject(agg!),
      emailStats: buildEmailStatsObject(agg!),
    });
  } catch (error: any) {
    console.error("[postmark-service] Error getting operation stats:", error);
    res.status(500).json({
      error: "Failed to get operation stats",
      details: messageOf(error),
    });
  }
});

// ── Org-scoped routes (API key + x-org-id required) ──────────────────────────

const orgsRouter = Router();

/** Above this many addresses, /orgs/status reads by scope + org instead of per address. */
const BIG_ASK_ADDRESSES = 1_000;

/**
 * POST /orgs/status
 * Batch status lookup by email with mode-dependent response shape.
 * Modes: brandId only → brand, campaignId only → campaign, both → campaign (brandId ignored), neither → global only.
 * Headers are tracing/logging only — filters are in the body.
 */
orgsRouter.post("/status", async (req: Request, res: Response) => {
  const parsed = StatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { brandId: brandIdRaw, campaignId, items } = parsed.data;
  const brandIds = brandIdRaw ? brandIdRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const mode: "brand" | "campaign" | "global" = campaignId
    ? "campaign"
    : brandIds.length > 0
      ? "brand"
      : "global";

  try {
    const allEmails = [...new Set(items.map((i) => i.email))];
    const orgId = (req as any).orgContext?.orgId as string | undefined;

    // ORGS-STATUS-TIMEOUT-1107: a big ask (our biggest brand sends ~60k addresses at once)
    // is answered from its scope's rows and the org's flagged rows directly: probing the
    // to_email index once per address cost ~1s per ask on prod, and the extra rows this reads
    // are never looked up (results are keyed by the asked items). A small ask (a single
    // follow-up) keeps the per-address probe, which is the cheap plan there.
    // When used, the addresses ride ONE array bind parameter, never one per address
    // (pg's 65,535 bind-parameter ceiling).
    const addressConditions: SQL[] = [];
    if (!orgId || allEmails.length <= BIG_ASK_ADDRESSES) {
      addressConditions.push(sql`${postmarkMessages.toEmail} = ANY(${new Param(allEmails)}::text[])`);
    }
    if (orgId) {
      addressConditions.push(eq(postmarkMessages.orgId, orgId));
    }

    // ORGS-STATUS-TIMEOUT-1107: narrow to the asked scope IN SQL. Decoding every org row of
    // every asked address (90k rows for our biggest brand) to keep 20 of them blocked the event
    // loop for seconds per ask; under a features-service boot burst asks timed out at the caller.
    const scopedRows: StatusRow[] =
      mode === "global"
        ? []
        : await db
            .select({
              messageId: postmarkMessages.messageId,
              toEmail: postmarkMessages.toEmail,
              campaignId: postmarkMessages.campaignId,
              brandIds: postmarkMessages.brandIds,
              contacted: postmarkMessages.contacted,
              sent: postmarkMessages.sent,
              delivered: postmarkMessages.delivered,
              opened: postmarkMessages.opened,
              clicked: postmarkMessages.clicked,
              bounced: postmarkMessages.bounced,
              unsubscribed: postmarkMessages.unsubscribed,
              lastDeliveredAt: postmarkMessages.lastDeliveredAt,
              submittedAt: postmarkMessages.submittedAt,
              createdAt: postmarkMessages.createdAt,
              firstOpenedAt: postmarkMessages.firstOpenedAt,
              firstClickedAt: postmarkMessages.firstClickedAt,
              firstBouncedAt: postmarkMessages.firstBouncedAt,
              firstUnsubscribedAt: postmarkMessages.firstUnsubscribedAt,
            })
            .from(postmarkMessages)
            .where(
              and(
                ...addressConditions,
                mode === "campaign"
                  ? eq(postmarkMessages.campaignId, campaignId!)
                  : sql`${postmarkMessages.brandIds} && ${new Param(brandIds)}::text[]`,
              ),
            );

    // Org-wide health flags: only addresses carrying one come back (absent = both false).
    const flagged = await db
      .select({
        toEmail: postmarkMessages.toEmail,
        bounced: sql<boolean>`bool_or(${postmarkMessages.bounced})`,
        unsubscribed: sql<boolean>`bool_or(${postmarkMessages.unsubscribed})`,
      })
      .from(postmarkMessages)
      .where(
        and(
          ...addressConditions,
          sql`(${postmarkMessages.bounced} OR ${postmarkMessages.unsubscribed})`,
        ),
      )
      .groupBy(postmarkMessages.toEmail);
    const flaggedEmails = new Map<string, GlobalFlags>(
      flagged.map((f) => [f.toEmail, { bounced: f.bounced === true, unsubscribed: f.unsubscribed === true }]),
    );

    res.type("application/json").send(serializeStatusResults(items, scopedRows, flaggedEmails, mode));
  } catch (error: any) {
    console.error("[postmark-service] Error checking status:", error);
    res.status(500).json({
      error: "Failed to check status",
      details: messageOf(error),
    });
  }
});

// ─── Stats helpers ────────────────────────────────────────────────────────────

const GROUP_BY_COLUMN_MAP = {
  campaignId: postmarkMessages.campaignId,
  workflowSlug: postmarkMessages.workflowSlug,
  featureSlug: postmarkMessages.featureSlug,
  audienceId: postmarkMessages.audienceId,
  recipientEmail: postmarkMessages.toEmail,
} as const;

function buildStatsConditions(data: {
  runIds?: string[];
  orgId?: string;
  brandId?: string[];
  campaignId?: string;
  audienceId?: string;
  workflowSlugs?: string[];
  featureSlugs?: string[];
}): SQL[] {
  const conditions: SQL[] = [];
  if (Array.isArray(data.runIds) && data.runIds.length > 0) {
    conditions.push(inArray(postmarkMessages.runId, data.runIds));
  }
  if (data.orgId) {
    conditions.push(eq(postmarkMessages.orgId, data.orgId));
  }
  if (data.brandId && data.brandId.length > 0) {
    conditions.push(arrayContains(postmarkMessages.brandIds, data.brandId));
  }
  if (data.campaignId) {
    conditions.push(eq(postmarkMessages.campaignId, data.campaignId));
  }
  if (data.audienceId) {
    conditions.push(eq(postmarkMessages.audienceId, data.audienceId));
  }
  if (data.workflowSlugs && data.workflowSlugs.length > 0) {
    conditions.push(inArray(postmarkMessages.workflowSlug, data.workflowSlugs));
  }
  if (data.featureSlugs && data.featureSlugs.length > 0) {
    conditions.push(inArray(postmarkMessages.featureSlug, data.featureSlugs));
  }
  return conditions;
}

const EMPTY_REPLIES_DETAIL = {
  interested: 0,
  meetingBooked: 0,
  closed: 0,
  notInterested: 0,
  wrongPerson: 0,
  unsubscribe: 0,
  neutral: 0,
  autoReply: 0,
  outOfOffice: 0,
};

interface AggregateRow {
  recipients_contacted: number;
  recipients_sent: number;
  recipients_delivered: number;
  recipients_opened: number;
  recipients_clicked: number;
  recipients_bounced: number;
  recipients_unsubscribed: number;
  emails_sent: number;
  emails_delivered: number;
  emails_opened: number;
  emails_clicked: number;
  emails_bounced: number;
  emails_unsubscribed: number;
  [key: string]: unknown;
}

function aggregateExprs() {
  return sql`
    COUNT(DISTINCT "to_email") FILTER (WHERE "contacted")::int AS recipients_contacted,
    COUNT(DISTINCT "to_email") FILTER (WHERE "sent")::int AS recipients_sent,
    COUNT(DISTINCT "to_email") FILTER (WHERE "delivered")::int AS recipients_delivered,
    COUNT(DISTINCT "to_email") FILTER (WHERE "opened")::int AS recipients_opened,
    COUNT(DISTINCT "to_email") FILTER (WHERE "clicked")::int AS recipients_clicked,
    COUNT(DISTINCT "to_email") FILTER (WHERE "bounced")::int AS recipients_bounced,
    COUNT(DISTINCT "to_email") FILTER (WHERE "unsubscribed")::int AS recipients_unsubscribed,
    COUNT(*) FILTER (WHERE "sent")::int AS emails_sent,
    COUNT(*) FILTER (WHERE "delivered")::int AS emails_delivered,
    COUNT(*) FILTER (WHERE "opened")::int AS emails_opened,
    COUNT(*) FILTER (WHERE "clicked")::int AS emails_clicked,
    COUNT(*) FILTER (WHERE "bounced")::int AS emails_bounced,
    COUNT(*) FILTER (WHERE "unsubscribed")::int AS emails_unsubscribed
  `;
}

function buildRecipientStatsObject(row: AggregateRow) {
  return {
    contacted: row.recipients_contacted,
    sent: row.recipients_sent,
    delivered: row.recipients_delivered,
    opened: row.recipients_opened,
    bounced: row.recipients_bounced,
    clicked: row.recipients_clicked,
    unsubscribed: row.recipients_unsubscribed,
    notSending: 0,
    repliesPositive: 0,
    repliesNegative: 0,
    repliesNeutral: 0,
    repliesAutoReply: 0,
    repliesDetail: EMPTY_REPLIES_DETAIL,
  };
}

function buildEmailStatsObject(row: AggregateRow) {
  return {
    sent: row.emails_sent,
    delivered: row.emails_delivered,
    opened: row.emails_opened,
    clicked: row.emails_clicked,
    bounced: row.emails_bounced,
    unsubscribed: row.emails_unsubscribed,
    stepStats: [] as never[],
  };
}

function emptyAggregate(): AggregateRow {
  return {
    recipients_contacted: 0,
    recipients_sent: 0,
    recipients_delivered: 0,
    recipients_opened: 0,
    recipients_clicked: 0,
    recipients_bounced: 0,
    recipients_unsubscribed: 0,
    emails_sent: 0,
    emails_delivered: 0,
    emails_opened: 0,
    emails_clicked: 0,
    emails_bounced: 0,
    emails_unsubscribed: 0,
  };
}

// ─── Shared stats handler ─────────────────────────────────────────────────────

async function handleStats(
  req: Request,
  res: Response,
  options: { allowGlobal?: boolean } = {}
) {
  const { allowGlobal = false } = options;
  const parsed = StatsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const {
    groupBy,
    runIds: runIdsRaw,
    brandId: brandIdRaw,
    workflowSlugs: workflowSlugsRaw,
    featureSlugs: featureSlugsRaw,
    ...filters
  } = parsed.data;
  const runIds = runIdsRaw ? runIdsRaw.split(",").filter(Boolean) : undefined;
  const brandId = brandIdRaw ? brandIdRaw.split(",").filter(Boolean) : undefined;
  const workflowSlugs = workflowSlugsRaw ? workflowSlugsRaw.split(",").filter(Boolean) : undefined;
  const featureSlugs = featureSlugsRaw ? featureSlugsRaw.split(",").filter(Boolean) : undefined;

  const conditions = buildStatsConditions({ ...filters, runIds, brandId, workflowSlugs, featureSlugs });

  // Service-auth /internal/stats allows an unfiltered call → global cross-org
  // aggregate (same scope class as the public leaderboard). Org-scoped /orgs/stats
  // scopes only via the ?orgId query param (NOT the x-org-id header), so an empty
  // filter there must stay a 400 — otherwise an org caller reads every org's data.
  if (conditions.length === 0 && !allowGlobal) {
    return res.status(400).json({
      error: "At least one filter is required (runIds, orgId, brandId, campaignId, audienceId, workflowSlugs, or featureSlugs)",
    });
  }

  const whereClause =
    conditions.length > 0 ? sql.join(conditions, sql` AND `) : sql`TRUE`;

  try {
    if (!groupBy) {
      const { rows } = await db.execute<AggregateRow>(sql`
        SELECT ${aggregateExprs()}
        FROM "postmark_messages"
        WHERE ${whereClause}
      `);
      const agg = rows[0] ?? emptyAggregate();
      return res.json({
        recipientStats: buildRecipientStatsObject(agg),
        emailStats: buildEmailStatsObject(agg),
      });
    }

    if (groupBy === "brandId") {
      const { rows } = await db.execute<AggregateRow & { group_key: string }>(sql`
        SELECT unnest("brand_ids") AS group_key, ${aggregateExprs()}
        FROM "postmark_messages"
        WHERE ${whereClause}
        GROUP BY group_key
      `);
      return res.json({
        groups: rows.map((r) => ({
          key: r.group_key,
          recipientStats: buildRecipientStatsObject(r),
          emailStats: buildEmailStatsObject(r),
        })),
      });
    }

    const groupColumn = GROUP_BY_COLUMN_MAP[groupBy];
    const { rows } = await db.execute<AggregateRow & { group_key: string | null }>(sql`
      SELECT ${groupColumn} AS group_key, ${aggregateExprs()}
      FROM "postmark_messages"
      WHERE ${whereClause}
      GROUP BY ${groupColumn}
    `);

    return res.json({
      groups: rows.map((r) => ({
        key: r.group_key ?? "",
        recipientStats: buildRecipientStatsObject(r),
        emailStats: buildEmailStatsObject(r),
      })),
    });
  } catch (error: any) {
    console.error("[postmark-service] Error getting stats:", error);
    res.status(500).json({
      error: "Failed to get stats",
      details: messageOf(error),
    });
  }
}


/**
 * GET /orgs/stats
 * Get aggregated email stats (requires identity headers)
 */
orgsRouter.get("/stats", (req, res) => handleStats(req, res, { allowGlobal: false }));

export default { internal: internalRouter, orgs: orgsRouter };
