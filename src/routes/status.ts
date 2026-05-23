import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkMessages, postmarkSendings } from "../db/schema";
import { eq, inArray, and, arrayContains, sql, SQL } from "drizzle-orm";
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
      details: error.message,
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
      details: error.message,
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
      details: error.message,
    });
  }
});

/**
 * GET /internal/stats
 * Same as /orgs/stats but only requires service API key (no identity headers).
 * Used by email-gateway for transactional stats aggregation.
 */
internalRouter.get("/stats", handleStats);

// ── Org-scoped routes (API key + x-org-id required) ──────────────────────────

const orgsRouter = Router();

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

    const conditions: SQL[] = [inArray(postmarkMessages.toEmail, allEmails)];
    if (orgId) {
      conditions.push(eq(postmarkMessages.orgId, orgId));
    }

    const rows = await db
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
      })
      .from(postmarkMessages)
      .where(and(...conditions));

    type Row = (typeof rows)[number];

    function aggregateScope(group: Row[]) {
      let contacted = false;
      let sent = false;
      let delivered = false;
      let opened = false;
      let clicked = false;
      let bounced = false;
      let unsubscribed = false;
      let lastDeliveredAt: Date | null = null;

      for (const r of group) {
        if (r.contacted) contacted = true;
        if (r.sent) sent = true;
        if (r.delivered) delivered = true;
        if (r.opened) opened = true;
        if (r.clicked) clicked = true;
        if (r.bounced) bounced = true;
        if (r.unsubscribed) unsubscribed = true;
        if (r.lastDeliveredAt) {
          const dt = r.lastDeliveredAt instanceof Date ? r.lastDeliveredAt : new Date(r.lastDeliveredAt);
          if (!lastDeliveredAt || dt > lastDeliveredAt) lastDeliveredAt = dt;
        }
      }

      return {
        contacted,
        sent,
        delivered,
        opened,
        clicked,
        replied: false,
        replyClassification: null as string | null,
        bounced,
        unsubscribed,
        cancelled: false,
        lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null,
      };
    }

    function aggregateGlobal(group: Row[]) {
      let bounced = false;
      let unsubscribed = false;
      for (const r of group) {
        if (r.bounced) bounced = true;
        if (r.unsubscribed) unsubscribed = true;
      }
      return { email: { bounced, unsubscribed } };
    }

    const results = items.map((item) => {
      const emailRows = rows.filter((r) => r.toEmail === item.email);
      const global = aggregateGlobal(emailRows);

      if (mode === "campaign") {
        return {
          email: item.email,
          byCampaign: null,
          brand: null,
          campaign: aggregateScope(emailRows.filter((r) => r.campaignId === campaignId)),
          global,
        };
      }

      if (mode === "brand") {
        const brandRows = emailRows.filter((r) => r.brandIds?.some((id) => brandIds.includes(id)));

        const campaignGroups = new Map<string, Row[]>();
        for (const r of brandRows) {
          if (r.campaignId) {
            let g = campaignGroups.get(r.campaignId);
            if (!g) {
              g = [];
              campaignGroups.set(r.campaignId, g);
            }
            g.push(r);
          }
        }

        const byCampaign: Record<string, ReturnType<typeof aggregateScope>> = {};
        for (const [cId, group] of campaignGroups) {
          byCampaign[cId] = aggregateScope(group);
        }

        return {
          email: item.email,
          byCampaign: Object.keys(byCampaign).length > 0 ? byCampaign : null,
          brand: aggregateScope(brandRows),
          campaign: null,
          global,
        };
      }

      return {
        email: item.email,
        byCampaign: null,
        brand: null,
        campaign: null,
        global,
      };
    });

    res.json({ results });
  } catch (error: any) {
    console.error("[postmark-service] Error checking status:", error);
    res.status(500).json({
      error: "Failed to check status",
      details: error.message,
    });
  }
});

// ─── Stats helpers ────────────────────────────────────────────────────────────

const GROUP_BY_COLUMN_MAP = {
  campaignId: postmarkMessages.campaignId,
  workflowSlug: postmarkMessages.workflowSlug,
  featureSlug: postmarkMessages.featureSlug,
  recipientEmail: postmarkMessages.toEmail,
} as const;

function buildStatsConditions(data: {
  runIds?: string[];
  orgId?: string;
  brandId?: string[];
  campaignId?: string;
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

async function handleStats(req: Request, res: Response) {
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

  if (conditions.length === 0) {
    return res.status(400).json({
      error: "At least one filter is required (runIds, orgId, brandId, campaignId, workflowSlugs, or featureSlugs)",
    });
  }

  const whereClause = sql.join(conditions, sql` AND `);

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
      details: error.message,
    });
  }
}

/**
 * GET /orgs/stats
 * Get aggregated email stats (requires identity headers)
 */
orgsRouter.get("/stats", handleStats);

export default { internal: internalRouter, orgs: orgsRouter };
