import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
  postmarkSubscriptionChanges,
} from "../db/schema";
import { eq, inArray, and, or, arrayContains, arrayOverlaps, sql, SQL } from "drizzle-orm";
import { StatsQuerySchema, StatusRequestSchema } from "../schemas";
import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchAllFeatureDynasties,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
} from "../lib/dynasty-client";

const router = Router();

/**
 * GET /status/:messageId
 * Get the full status of an email by its Postmark message ID
 */
router.get("/status/:messageId", async (req: Request, res: Response) => {
  const { messageId } = req.params;

  if (!messageId) {
    return res.status(400).json({ error: "messageId is required" });
  }

  try {
    // Get sending record
    const [sending] = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.messageId, messageId))
      .limit(1);

    if (!sending) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Get delivery record
    const [delivery] = await db
      .select()
      .from(postmarkDeliveries)
      .where(eq(postmarkDeliveries.messageId, messageId))
      .limit(1);

    // Get bounce record
    const [bounce] = await db
      .select()
      .from(postmarkBounces)
      .where(eq(postmarkBounces.messageId, messageId))
      .limit(1);

    // Get openings (can be multiple)
    const openings = await db
      .select()
      .from(postmarkOpenings)
      .where(eq(postmarkOpenings.messageId, messageId));

    // Get link clicks (can be multiple)
    const clicks = await db
      .select()
      .from(postmarkLinkClicks)
      .where(eq(postmarkLinkClicks.messageId, messageId));

    // Determine overall status
    let status: "sent" | "delivered" | "bounced" | "opened" | "clicked";
    if (clicks.length > 0) {
      status = "clicked";
    } else if (openings.length > 0) {
      status = "opened";
    } else if (bounce) {
      status = "bounced";
    } else if (delivery) {
      status = "delivered";
    } else {
      status = "sent";
    }

    res.json({
      messageId,
      status,
      sending: {
        id: sending.id,
        to: sending.toEmail,
        from: sending.fromEmail,
        subject: sending.subject,
        submittedAt: sending.submittedAt,
        orgId: sending.orgId,
        runId: sending.runId,
      },
      delivery: delivery
        ? {
            deliveredAt: delivery.deliveredAt,
            recipient: delivery.recipient,
          }
        : null,
      bounce: bounce
        ? {
            type: bounce.type,
            typeCode: bounce.typeCode,
            description: bounce.description,
            bouncedAt: bounce.bouncedAt,
            email: bounce.email,
          }
        : null,
      openings: openings.map((o) => ({
        receivedAt: o.receivedAt,
        firstOpen: o.firstOpen,
        platform: o.platform,
        readSeconds: o.readSeconds,
        geo: o.geo,
      })),
      clicks: clicks.map((c) => ({
        receivedAt: c.receivedAt,
        originalLink: c.originalLink,
        clickLocation: c.clickLocation,
        platform: c.platform,
        geo: c.geo,
      })),
    });
  } catch (error: any) {
    console.error("Error getting message status:", error);
    res.status(500).json({
      error: "Failed to get message status",
      details: error.message,
    });
  }
});

/**
 * GET /status/by-org/:orgId
 * Get recent emails for an organization
 */
router.get("/status/by-org/:orgId", async (req: Request, res: Response) => {
  const { orgId } = req.params;
  const limit = parseInt(req.query.limit as string) || 50;

  if (!orgId) {
    return res.status(400).json({ error: "orgId is required" });
  }

  try {
    const sendings = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.orgId, orgId))
      .orderBy(postmarkSendings.createdAt)
      .limit(limit);

    res.json({
      orgId,
      count: sendings.length,
      emails: sendings.map((s) => ({
        id: s.id,
        messageId: s.messageId,
        to: s.toEmail,
        subject: s.subject,
        submittedAt: s.submittedAt,
        runId: s.runId,
        errorCode: s.errorCode,
      })),
    });
  } catch (error: any) {
    console.error("Error getting org emails:", error);
    res.status(500).json({
      error: "Failed to get org emails",
      details: error.message,
    });
  }
});

/**
 * GET /status/by-run/:runId
 * Get emails for a specific run
 */
router.get("/status/by-run/:runId", async (req: Request, res: Response) => {
  const { runId } = req.params;

  if (!runId) {
    return res.status(400).json({ error: "runId is required" });
  }

  try {
    const sendings = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.runId, runId))
      .orderBy(postmarkSendings.createdAt);

    res.json({
      runId,
      total: sendings.length,
      emails: sendings.map((s) => ({
        id: s.id,
        messageId: s.messageId,
        to: s.toEmail,
        subject: s.subject,
        submittedAt: s.submittedAt,
        success: s.errorCode === 0,
      })),
    });
  } catch (error: any) {
    console.error("Error getting campaign emails:", error);
    res.status(500).json({
      error: "Failed to get campaign emails",
      details: error.message,
    });
  }
});

/**
 * POST /status
 * Batch status lookup by lead+email pairs with campaign/brand/global scopes
 */
router.post("/status", async (req: Request, res: Response) => {
  const brandId = req.headers["x-brand-id"] as string | undefined;
  if (!brandId) {
    return res.status(400).json({
      error: "Missing required header: x-brand-id",
    });
  }

  const parsed = StatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { campaignId, items } = parsed.data;

  try {
    // 1. Collect unique leadIds and emails
    const allLeadIds = [...new Set(items.map((i) => i.leadId))];
    const allEmails = [...new Set(items.map((i) => i.email))];

    // 2. Query all sendings matching any leadId or email (covers all scopes)
    const conditions: SQL[] = [];
    if (allLeadIds.length > 0) {
      conditions.push(inArray(postmarkSendings.leadId, allLeadIds));
    }
    if (allEmails.length > 0) {
      conditions.push(inArray(postmarkSendings.toEmail, allEmails));
    }

    const sendings = await db
      .select({
        messageId: postmarkSendings.messageId,
        toEmail: postmarkSendings.toEmail,
        leadId: postmarkSendings.leadId,
        campaignId: postmarkSendings.campaignId,
        brandIds: postmarkSendings.brandIds,
      })
      .from(postmarkSendings)
      .where(or(...conditions));

    // 3. Batch-query events for all messageIds
    const allMessageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    const [deliveries, bounces, subscriptionChanges] = allMessageIds.length > 0
      ? await Promise.all([
          db.select({ messageId: postmarkDeliveries.messageId, deliveredAt: postmarkDeliveries.deliveredAt })
            .from(postmarkDeliveries)
            .where(inArray(postmarkDeliveries.messageId, allMessageIds)),
          db.select({ messageId: postmarkBounces.messageId })
            .from(postmarkBounces)
            .where(inArray(postmarkBounces.messageId, allMessageIds)),
          db.select({ messageId: postmarkSubscriptionChanges.messageId, suppressSending: postmarkSubscriptionChanges.suppressSending })
            .from(postmarkSubscriptionChanges)
            .where(inArray(postmarkSubscriptionChanges.messageId, allMessageIds)),
        ])
      : [[], [], []];

    // 4. Build lookup maps
    const deliveryMap = new Map<string, Date | null>();
    for (const d of deliveries) {
      if (d.messageId) deliveryMap.set(d.messageId, d.deliveredAt);
    }
    const bouncedSet = new Set(bounces.map((b) => b.messageId).filter((id): id is string => !!id));
    const unsubSet = new Set(
      subscriptionChanges
        .filter((sc) => sc.suppressSending === true)
        .map((sc) => sc.messageId)
        .filter((id): id is string => !!id)
    );

    // 5. Aggregation helpers
    type SendingRow = typeof sendings[number];

    function aggregateLead(rows: SendingRow[]) {
      let contacted = false;
      let delivered = false;
      let lastDeliveredAt: Date | null = null;

      for (const s of rows) {
        contacted = true;
        if (s.messageId && deliveryMap.has(s.messageId)) {
          delivered = true;
          const dt = deliveryMap.get(s.messageId)!;
          if (dt && (!lastDeliveredAt || dt > lastDeliveredAt)) {
            lastDeliveredAt = dt;
          }
        }
      }

      return {
        contacted,
        delivered,
        replied: false,
        lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null,
      };
    }

    function aggregateEmail(rows: SendingRow[]) {
      let contacted = false;
      let delivered = false;
      let bounced = false;
      let unsubscribed = false;
      let lastDeliveredAt: Date | null = null;

      for (const s of rows) {
        contacted = true;
        if (s.messageId) {
          if (deliveryMap.has(s.messageId)) {
            delivered = true;
            const dt = deliveryMap.get(s.messageId)!;
            if (dt && (!lastDeliveredAt || dt > lastDeliveredAt)) {
              lastDeliveredAt = dt;
            }
          }
          if (bouncedSet.has(s.messageId)) bounced = true;
          if (unsubSet.has(s.messageId)) unsubscribed = true;
        }
      }

      return {
        contacted,
        delivered,
        bounced,
        unsubscribed,
        lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null,
      };
    }

    // 6. Build results per item
    const results = items.map((item) => {
      // Campaign scope (null if no campaignId)
      const campaignScope = campaignId ? (() => {
        const campaignLeadRows = sendings.filter(
          (s) => s.leadId === item.leadId && s.campaignId === campaignId
        );
        const campaignEmailRows = sendings.filter(
          (s) => s.toEmail === item.email && s.campaignId === campaignId
        );
        return {
          lead: aggregateLead(campaignLeadRows),
          email: aggregateEmail(campaignEmailRows),
        };
      })() : null;

      // Brand scope
      const brandLeadRows = sendings.filter(
        (s) => s.leadId === item.leadId && s.brandIds?.includes(brandId)
      );
      const brandEmailRows = sendings.filter(
        (s) => s.toEmail === item.email && s.brandIds?.includes(brandId)
      );

      // Global scope — only bounced + unsubscribed for this email across everything
      const globalEmailRows = sendings.filter((s) => s.toEmail === item.email);
      const globalEmailAgg = aggregateEmail(globalEmailRows);

      return {
        leadId: item.leadId,
        email: item.email,
        campaign: campaignScope,
        brand: {
          lead: aggregateLead(brandLeadRows),
          email: aggregateEmail(brandEmailRows),
        },
        global: {
          email: {
            bounced: globalEmailAgg.bounced,
            unsubscribed: globalEmailAgg.unsubscribed,
          },
        },
      };
    });

    res.json({ results });
  } catch (error: any) {
    console.error("Error checking status:", error);
    res.status(500).json({
      error: "Failed to check status",
      details: error.message,
    });
  }
});

// ─── Stats helpers ────────────────────────────────────────────────────────────

const GROUP_BY_COLUMN_MAP = {
  campaignId: postmarkSendings.campaignId,
  workflowSlug: postmarkSendings.workflowSlug,
  featureSlug: postmarkSendings.featureSlug,
  leadEmail: postmarkSendings.toEmail,
} as const;

function buildStatsConditions(data: {
  runIds?: string[];
  orgId?: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  workflowSlugs?: string[];
  featureSlugs?: string[];
}): SQL[] {
  const conditions: SQL[] = [];
  if (Array.isArray(data.runIds) && data.runIds.length > 0) {
    conditions.push(inArray(postmarkSendings.runId, data.runIds));
  }
  if (data.orgId) {
    conditions.push(eq(postmarkSendings.orgId, data.orgId));
  }
  if (data.brandId) {
    conditions.push(arrayContains(postmarkSendings.brandIds, [data.brandId]));
  }
  if (data.campaignId) {
    conditions.push(eq(postmarkSendings.campaignId, data.campaignId));
  }
  if (data.workflowSlugs && data.workflowSlugs.length > 0) {
    conditions.push(inArray(postmarkSendings.workflowSlug, data.workflowSlugs));
  } else if (data.workflowSlug) {
    conditions.push(eq(postmarkSendings.workflowSlug, data.workflowSlug));
  }
  if (data.featureSlugs && data.featureSlugs.length > 0) {
    conditions.push(inArray(postmarkSendings.featureSlug, data.featureSlugs));
  } else if (data.featureSlug) {
    conditions.push(eq(postmarkSendings.featureSlug, data.featureSlug));
  }
  return conditions;
}

async function computeStats(messageIds: string[]) {
  const stats = {
    emailsDelivered: 0,
    emailsOpened: 0,
    emailsClicked: 0,
    emailsBounced: 0,
  };

  if (messageIds.length === 0) return stats;

  const [deliveries, openings, clicks, bounces] = await Promise.all([
    db.select({ messageId: postmarkDeliveries.messageId })
      .from(postmarkDeliveries)
      .where(inArray(postmarkDeliveries.messageId, messageIds)),
    db.select({ messageId: postmarkOpenings.messageId })
      .from(postmarkOpenings)
      .where(inArray(postmarkOpenings.messageId, messageIds)),
    db.select({ messageId: postmarkLinkClicks.messageId })
      .from(postmarkLinkClicks)
      .where(inArray(postmarkLinkClicks.messageId, messageIds)),
    db.select({ messageId: postmarkBounces.messageId })
      .from(postmarkBounces)
      .where(inArray(postmarkBounces.messageId, messageIds)),
  ]);

  stats.emailsDelivered = deliveries.length;
  stats.emailsOpened = new Set(openings.map((o) => o.messageId)).size;
  stats.emailsClicked = new Set(clicks.map((c) => c.messageId)).size;
  stats.emailsBounced = bounces.length;

  return stats;
}

function buildStatsObject(emailsSent: number, eventStats: Awaited<ReturnType<typeof computeStats>>) {
  return {
    emailsContacted: emailsSent,
    emailsSent,
    emailsDelivered: eventStats.emailsDelivered,
    emailsOpened: eventStats.emailsOpened,
    emailsClicked: eventStats.emailsClicked,
    emailsReplied: 0,
    emailsBounced: eventStats.emailsBounced,
    repliesWillingToMeet: 0,
    repliesInterested: 0,
    repliesNotInterested: 0,
    repliesOutOfOffice: 0,
    repliesUnsubscribe: 0,
  };
}

// ─── GET /stats handler ───────────────────────────────────────────────────────

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
    workflowSlugs: workflowSlugsRaw,
    featureSlugs: featureSlugsRaw,
    workflowDynastySlug,
    featureDynastySlug,
    ...filters
  } = parsed.data;
  const runIds = runIdsRaw ? runIdsRaw.split(",").filter(Boolean) : undefined;
  const workflowSlugsFromQuery = workflowSlugsRaw ? workflowSlugsRaw.split(",").filter(Boolean) : undefined;
  const featureSlugsFromQuery = featureSlugsRaw ? featureSlugsRaw.split(",").filter(Boolean) : undefined;

  // Resolve dynasty slugs → versioned slug lists via external services
  const identityHeaders = {
    orgId: (req.headers["x-org-id"] as string) || "",
    userId: (req.headers["x-user-id"] as string) || "",
    runId: (req.headers["x-run-id"] as string) || "",
  };

  let workflowSlugs: string[] | undefined = workflowSlugsFromQuery;
  let featureSlugs: string[] | undefined = featureSlugsFromQuery;

  if (workflowDynastySlug) {
    const dynastySlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug, identityHeaders);
    if (dynastySlugs.length === 0 && !workflowSlugs) {
      // Dynasty exists but has no slugs — return empty stats
      return res.json(groupBy ? { groups: [] } : { stats: buildStatsObject(0, { emailsDelivered: 0, emailsOpened: 0, emailsClicked: 0, emailsBounced: 0 }), recipients: 0 });
    }
    workflowSlugs = workflowSlugs ? [...workflowSlugs, ...dynastySlugs] : dynastySlugs;
  }

  if (featureDynastySlug) {
    const dynastySlugs = await resolveFeatureDynastySlugs(featureDynastySlug, identityHeaders);
    if (dynastySlugs.length === 0 && !featureSlugs) {
      return res.json(groupBy ? { groups: [] } : { stats: buildStatsObject(0, { emailsDelivered: 0, emailsOpened: 0, emailsClicked: 0, emailsBounced: 0 }), recipients: 0 });
    }
    featureSlugs = featureSlugs ? [...featureSlugs, ...dynastySlugs] : dynastySlugs;
  }

  const conditions = buildStatsConditions({ ...filters, runIds, workflowSlugs, featureSlugs });

  if (conditions.length === 0) {
    return res.status(400).json({
      error: "At least one filter is required (runIds, orgId, brandId, campaignId, workflowSlug, featureSlug, workflowSlugs, featureSlugs, workflowDynastySlug, or featureDynastySlug)",
    });
  }

  try {
    if (!groupBy) {
      // ─── Flat response (backwards compatible) ────────────────────────
      const sendings = await db
        .select({
          messageId: postmarkSendings.messageId,
          toEmail: postmarkSendings.toEmail,
        })
        .from(postmarkSendings)
        .where(and(...conditions));

      const messageIds = sendings
        .map((s) => s.messageId)
        .filter((id): id is string => id !== null);

      const eventStats = await computeStats(messageIds);
      const recipients = new Set(sendings.map((s) => s.toEmail)).size;

      return res.json({
        stats: buildStatsObject(sendings.length, eventStats),
        recipients,
      });
    }

    // ─── Grouped response ────────────────────────────────────────────
    const isDynastyGroupBy = groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug";
    const isBrandGroupBy = groupBy === "brandId";

    // For dynasty groupBy, fetch all dynasties and build reverse map
    let slugToDynastyMap: Map<string, string> | undefined;
    if (groupBy === "workflowDynastySlug") {
      const dynasties = await fetchAllWorkflowDynasties(identityHeaders);
      slugToDynastyMap = buildSlugToDynastyMap(dynasties);
    } else if (groupBy === "featureDynastySlug") {
      const dynasties = await fetchAllFeatureDynasties(identityHeaders);
      slugToDynastyMap = buildSlugToDynastyMap(dynasties);
    }

    // brandId groupBy requires unnesting the brand_ids array
    type SendingRow = { messageId: string | null; toEmail: string; groupKey: string | null };
    let sendings: SendingRow[];

    if (isBrandGroupBy) {
      // Use unnest to expand brand_ids array into per-brand rows
      const rows = await db.execute<{ message_id: string | null; to_email: string; brand_id: string | null }>(
        sql`SELECT ps.message_id, ps.to_email, unnest(ps.brand_ids) AS brand_id
            FROM postmark_sendings ps
            ${conditions.length > 0 ? sql`WHERE ${and(...conditions)}` : sql``}`
      );
      sendings = rows.rows.map((r) => ({
        messageId: r.message_id,
        toEmail: r.to_email,
        groupKey: r.brand_id,
      }));
    } else {
      const dbColumn = isDynastyGroupBy
        ? (groupBy === "workflowDynastySlug" ? postmarkSendings.workflowSlug : postmarkSendings.featureSlug)
        : GROUP_BY_COLUMN_MAP[groupBy];

      sendings = await db
        .select({
          messageId: postmarkSendings.messageId,
          toEmail: postmarkSendings.toEmail,
          groupKey: dbColumn,
        })
        .from(postmarkSendings)
        .where(and(...conditions));
    }

    // Group sendings by dimension key (resolving to dynasty slug when needed)
    const grouped = new Map<string, { messageIds: string[]; toEmails: Set<string>; count: number }>();
    for (const s of sendings) {
      const rawKey = s.groupKey ?? "";
      const key = slugToDynastyMap ? (slugToDynastyMap.get(rawKey) ?? rawKey) : rawKey;
      let group = grouped.get(key);
      if (!group) {
        group = { messageIds: [], toEmails: new Set(), count: 0 };
        grouped.set(key, group);
      }
      group.count++;
      group.toEmails.add(s.toEmail);
      if (s.messageId) group.messageIds.push(s.messageId);
    }

    // Compute stats for all messageIds at once, then distribute
    const allMessageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    // Fetch all events in parallel
    const [allDeliveries, allOpenings, allClicks, allBounces] = allMessageIds.length > 0
      ? await Promise.all([
          db.select({ messageId: postmarkDeliveries.messageId })
            .from(postmarkDeliveries)
            .where(inArray(postmarkDeliveries.messageId, allMessageIds)),
          db.select({ messageId: postmarkOpenings.messageId })
            .from(postmarkOpenings)
            .where(inArray(postmarkOpenings.messageId, allMessageIds)),
          db.select({ messageId: postmarkLinkClicks.messageId })
            .from(postmarkLinkClicks)
            .where(inArray(postmarkLinkClicks.messageId, allMessageIds)),
          db.select({ messageId: postmarkBounces.messageId })
            .from(postmarkBounces)
            .where(inArray(postmarkBounces.messageId, allMessageIds)),
        ])
      : [[], [], [], []];

    // Build lookup sets for O(1) membership checks
    const deliveredSet = new Set(allDeliveries.map((d) => d.messageId));
    const openedSet = new Set(allOpenings.map((o) => o.messageId));
    const clickedSet = new Set(allClicks.map((c) => c.messageId));
    const bouncedSet = new Set(allBounces.map((b) => b.messageId));

    const groups = Array.from(grouped.entries()).map(([key, group]) => {
      const eventStats = {
        emailsDelivered: group.messageIds.filter((id) => deliveredSet.has(id)).length,
        emailsOpened: group.messageIds.filter((id) => openedSet.has(id)).length,
        emailsClicked: group.messageIds.filter((id) => clickedSet.has(id)).length,
        emailsBounced: group.messageIds.filter((id) => bouncedSet.has(id)).length,
      };

      return {
        key,
        stats: buildStatsObject(group.count, eventStats),
        recipients: group.toEmails.size,
      };
    });

    return res.json({ groups });
  } catch (error: any) {
    console.error("Error getting stats:", error);
    res.status(500).json({
      error: "Failed to get stats",
      details: error.message,
    });
  }
}

/**
 * GET /stats
 * Get aggregated email stats (requires identity headers)
 */
router.get("/stats", handleStats);

/**
 * GET /stats/public
 * Same as /stats but only requires service API key (no identity headers).
 * Used by email-gateway for transactional stats aggregation.
 */
router.get("/stats/public", handleStats);

export default router;
