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
import { eq, inArray, and, arrayContains, sql, SQL } from "drizzle-orm";
import { StatsQuerySchema, StatusRequestSchema } from "../schemas";
import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchAllFeatureDynasties,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
} from "../lib/dynasty-client";

// ── Internal routes (API key only, no identity headers) ───────────────────────

const internalRouter = Router();

/**
 * Compute Layer 2 status for a single message from raw events.
 * Applies the full implication chain: contacted → sent → delivered → opened → clicked
 */
function computeMessageStatus(
  sending: { errorCode: number | null; messageId: string | null },
  events: {
    deliveryMap: Map<string, Date | null>;
    bouncedSet: Set<string>;
    openedSet: Set<string>;
    clickedSet: Set<string>;
    unsubSet: Set<string>;
  },
) {
  const mid = sending.messageId;
  const hasDelivery = mid ? events.deliveryMap.has(mid) : false;
  const hasBounce = mid ? events.bouncedSet.has(mid) : false;
  const hasOpen = mid ? events.openedSet.has(mid) : false;
  const hasClick = mid ? events.clickedSet.has(mid) : false;
  const hasUnsub = mid ? events.unsubSet.has(mid) : false;

  // Implication chain: click → open → delivered → sent → contacted
  const clicked = hasClick;
  const opened = hasOpen || clicked;
  const delivered = (hasDelivery || opened) && !hasBounce;
  const sent = (sending.errorCode === 0) || hasDelivery || opened || clicked || hasBounce;
  const contacted = true;

  const deliveredAt = mid ? events.deliveryMap.get(mid) ?? null : null;

  return {
    contacted,
    sent,
    delivered,
    opened,
    clicked,
    replied: false,
    replyClassification: null,
    bounced: hasBounce,
    unsubscribed: hasUnsub,
    lastDeliveredAt: deliveredAt?.toISOString() ?? null,
  };
}

/**
 * Batch-query all events for a set of messageIds and return lookup maps.
 */
async function fetchEventMaps(messageIds: string[]) {
  if (messageIds.length === 0) {
    return {
      deliveryMap: new Map<string, Date | null>(),
      bouncedSet: new Set<string>(),
      openedSet: new Set<string>(),
      clickedSet: new Set<string>(),
      unsubSet: new Set<string>(),
    };
  }

  const [deliveries, bounces, openings, clicks, subscriptionChanges] = await Promise.all([
    db.select({ messageId: postmarkDeliveries.messageId, deliveredAt: postmarkDeliveries.deliveredAt })
      .from(postmarkDeliveries)
      .where(inArray(postmarkDeliveries.messageId, messageIds)),
    db.select({ messageId: postmarkBounces.messageId })
      .from(postmarkBounces)
      .where(inArray(postmarkBounces.messageId, messageIds)),
    db.select({ messageId: postmarkOpenings.messageId })
      .from(postmarkOpenings)
      .where(inArray(postmarkOpenings.messageId, messageIds)),
    db.select({ messageId: postmarkLinkClicks.messageId })
      .from(postmarkLinkClicks)
      .where(inArray(postmarkLinkClicks.messageId, messageIds)),
    db.select({ messageId: postmarkSubscriptionChanges.messageId, suppressSending: postmarkSubscriptionChanges.suppressSending })
      .from(postmarkSubscriptionChanges)
      .where(inArray(postmarkSubscriptionChanges.messageId, messageIds)),
  ]);

  const deliveryMap = new Map<string, Date | null>();
  for (const d of deliveries) {
    if (d.messageId) deliveryMap.set(d.messageId, d.deliveredAt);
  }

  return {
    deliveryMap,
    bouncedSet: new Set(bounces.map((b) => b.messageId).filter((id): id is string => !!id)),
    openedSet: new Set(openings.map((o) => o.messageId).filter((id): id is string => !!id)),
    clickedSet: new Set(clicks.map((c) => c.messageId).filter((id): id is string => !!id)),
    unsubSet: new Set(
      subscriptionChanges
        .filter((sc) => sc.suppressSending === true)
        .map((sc) => sc.messageId)
        .filter((id): id is string => !!id)
    ),
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
    const [sending] = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.messageId, messageId))
      .limit(1);

    if (!sending) {
      return res.status(404).json({ error: "Message not found" });
    }

    const events = await fetchEventMaps([messageId]);
    const status = computeMessageStatus(sending, events);

    res.json({
      messageId,
      sending: {
        id: sending.id,
        to: sending.toEmail,
        from: sending.fromEmail,
        subject: sending.subject,
        submittedAt: sending.submittedAt,
        orgId: sending.orgId,
        runId: sending.runId,
      },
      status,
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
      .from(postmarkSendings)
      .where(eq(postmarkSendings.orgId, orgId))
      .orderBy(postmarkSendings.createdAt);

    const sendings = limitParam ? await query.limit(limitParam) : await query;

    const messageIds = sendings.map((s) => s.messageId).filter((id): id is string => id !== null);
    const events = await fetchEventMaps(messageIds);

    res.json({
      orgId,
      count: sendings.length,
      emails: sendings.map((s) => ({
        messageId: s.messageId,
        to: s.toEmail,
        subject: s.subject,
        submittedAt: s.submittedAt,
        status: computeMessageStatus(s, events),
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
    const sendings = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.runId, runId))
      .orderBy(postmarkSendings.createdAt);

    const messageIds = sendings.map((s) => s.messageId).filter((id): id is string => id !== null);
    const events = await fetchEventMaps(messageIds);

    res.json({
      runId,
      total: sendings.length,
      emails: sendings.map((s) => ({
        messageId: s.messageId,
        to: s.toEmail,
        subject: s.subject,
        submittedAt: s.submittedAt,
        status: computeMessageStatus(s, events),
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
 * Modes: brandIds only → brand, campaignId only → campaign, both → campaign (brandIds ignored), neither → global only.
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

  const { brandIds, campaignId, items } = parsed.data;

  // Mode resolution: campaignId takes precedence over brandIds
  const mode: "brand" | "campaign" | "global" = campaignId
    ? "campaign"
    : brandIds && brandIds.length > 0
      ? "brand"
      : "global";

  try {
    // 1. Collect unique emails
    const allEmails = [...new Set(items.map((i) => i.email))];

    // 2. Query all sendings matching any email in this org
    const orgId = (req as any).orgContext?.orgId as string | undefined;
    const sendingConditions: SQL[] = [inArray(postmarkSendings.toEmail, allEmails)];
    if (orgId) {
      sendingConditions.push(eq(postmarkSendings.orgId, orgId));
    }

    const sendings = await db
      .select({
        messageId: postmarkSendings.messageId,
        toEmail: postmarkSendings.toEmail,
        errorCode: postmarkSendings.errorCode,
        campaignId: postmarkSendings.campaignId,
        brandIds: postmarkSendings.brandIds,
      })
      .from(postmarkSendings)
      .where(and(...sendingConditions));

    // 3. Batch-query events for all messageIds
    const allMessageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    const events = await fetchEventMaps(allMessageIds);

    // 4. Scope aggregation helper — BOOL_OR of per-message Layer 2 status
    type SendingRow = typeof sendings[number];

    function aggregateScope(rows: SendingRow[]) {
      let contacted = false;
      let sent = false;
      let delivered = false;
      let opened = false;
      let clicked = false;
      let bounced = false;
      let unsubscribed = false;
      let lastDeliveredAt: Date | null = null;

      for (const s of rows) {
        const msgStatus = computeMessageStatus(s, events);
        if (msgStatus.contacted) contacted = true;
        if (msgStatus.sent) sent = true;
        if (msgStatus.delivered) delivered = true;
        if (msgStatus.opened) opened = true;
        if (msgStatus.clicked) clicked = true;
        if (msgStatus.bounced) bounced = true;
        if (msgStatus.unsubscribed) unsubscribed = true;
        if (msgStatus.lastDeliveredAt) {
          const dt = new Date(msgStatus.lastDeliveredAt);
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
        replyClassification: null,
        bounced,
        unsubscribed,
        lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null,
      };
    }

    // 5. Global scope helper — only bounced/unsubscribed across all org sendings
    function aggregateGlobal(rows: SendingRow[]) {
      let bounced = false;
      let unsubscribed = false;

      for (const s of rows) {
        if (s.messageId) {
          if (events.bouncedSet.has(s.messageId)) bounced = true;
          if (events.unsubSet.has(s.messageId)) unsubscribed = true;
        }
      }

      return { email: { bounced, unsubscribed } };
    }

    // 7. Build results per item
    const results = items.map((item) => {
      const emailRows = sendings.filter((s) => s.toEmail === item.email);

      // Global — all sendings for this email in the org
      const global = aggregateGlobal(emailRows);

      if (mode === "campaign") {
        return {
          email: item.email,
          byCampaign: null,
          brand: null,
          campaign: aggregateScope(emailRows.filter((s) => s.campaignId === campaignId)),
          global,
        };
      }

      if (mode === "brand") {
        // Brand-filtered rows
        const brandRows = emailRows.filter((s) => s.brandIds?.some((id) => brandIds!.includes(id)));

        // Group by campaignId for byCampaign breakdown
        const campaignGroups = new Map<string, SendingRow[]>();
        for (const row of brandRows) {
          if (row.campaignId) {
            let group = campaignGroups.get(row.campaignId);
            if (!group) {
              group = [];
              campaignGroups.set(row.campaignId, group);
            }
            group.push(row);
          }
        }

        const byCampaign: Record<string, ReturnType<typeof aggregateScope>> = {};
        for (const [cId, rows] of campaignGroups) {
          byCampaign[cId] = aggregateScope(rows);
        }

        return {
          email: item.email,
          byCampaign: Object.keys(byCampaign).length > 0 ? byCampaign : null,
          brand: aggregateScope(brandRows),
          campaign: null,
          global,
        };
      }

      // Global-only mode
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
  campaignId: postmarkSendings.campaignId,
  workflowSlug: postmarkSendings.workflowSlug,
  featureSlug: postmarkSendings.featureSlug,
  recipientEmail: postmarkSendings.toEmail,
} as const;

function buildStatsConditions(data: {
  runIds?: string[];
  orgId?: string;
  brandIds?: string[];
  campaignId?: string;
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
  if (data.brandIds && data.brandIds.length > 0) {
    conditions.push(arrayContains(postmarkSendings.brandIds, data.brandIds));
  }
  if (data.campaignId) {
    conditions.push(eq(postmarkSendings.campaignId, data.campaignId));
  }
  if (data.workflowSlugs && data.workflowSlugs.length > 0) {
    conditions.push(inArray(postmarkSendings.workflowSlug, data.workflowSlugs));
  }
  if (data.featureSlugs && data.featureSlugs.length > 0) {
    conditions.push(inArray(postmarkSendings.featureSlug, data.featureSlugs));
  }
  return conditions;
}

/**
 * Compute stats by unique recipient with full implication chain.
 * Each recipient is counted once per metric — if ANY of their messages has the status, they count.
 */
function computeRecipientStats(
  sendings: { messageId: string | null; toEmail: string; errorCode?: number | null }[],
  eventMaps: Awaited<ReturnType<typeof fetchEventMaps>>,
) {
  // Group messages by recipient
  const byRecipient = new Map<string, typeof sendings>();
  for (const s of sendings) {
    let group = byRecipient.get(s.toEmail);
    if (!group) {
      group = [];
      byRecipient.set(s.toEmail, group);
    }
    group.push(s);
  }

  let emailsContacted = 0;
  let emailsSent = 0;
  let emailsDelivered = 0;
  let emailsOpened = 0;
  let emailsClicked = 0;
  let emailsBounced = 0;

  for (const [, msgs] of byRecipient) {
    let rContacted = false;
    let rSent = false;
    let rDelivered = false;
    let rOpened = false;
    let rClicked = false;
    let rBounced = false;

    for (const s of msgs) {
      const status = computeMessageStatus(
        { errorCode: s.errorCode ?? null, messageId: s.messageId },
        eventMaps,
      );
      if (status.contacted) rContacted = true;
      if (status.sent) rSent = true;
      if (status.delivered) rDelivered = true;
      if (status.opened) rOpened = true;
      if (status.clicked) rClicked = true;
      if (status.bounced) rBounced = true;
    }

    if (rContacted) emailsContacted++;
    if (rSent) emailsSent++;
    if (rDelivered) emailsDelivered++;
    if (rOpened) emailsOpened++;
    if (rClicked) emailsClicked++;
    if (rBounced) emailsBounced++;
  }

  return { emailsContacted, emailsSent, emailsDelivered, emailsOpened, emailsClicked, emailsBounced };
}

function buildStatsObject(recipientStats: ReturnType<typeof computeRecipientStats>) {
  return {
    emailsContacted: recipientStats.emailsContacted,
    emailsSent: recipientStats.emailsSent,
    emailsDelivered: recipientStats.emailsDelivered,
    emailsOpened: recipientStats.emailsOpened,
    emailsClicked: recipientStats.emailsClicked,
    emailsBounced: recipientStats.emailsBounced,
    repliesPositive: 0,
    repliesNegative: 0,
    repliesNeutral: 0,
    repliesAutoReply: 0,
    repliesDetail: {
      interested: 0,
      meetingBooked: 0,
      closed: 0,
      notInterested: 0,
      wrongPerson: 0,
      unsubscribe: 0,
      neutral: 0,
      autoReply: 0,
      outOfOffice: 0,
    },
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
    brandIds: brandIdsRaw,
    workflowSlugs: workflowSlugsRaw,
    featureSlugs: featureSlugsRaw,
    workflowDynastySlug,
    featureDynastySlug,
    ...filters
  } = parsed.data;
  const runIds = runIdsRaw ? runIdsRaw.split(",").filter(Boolean) : undefined;
  const brandIds = brandIdsRaw ? brandIdsRaw.split(",").filter(Boolean) : undefined;
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

  const emptyStats = { emailsContacted: 0, emailsSent: 0, emailsDelivered: 0, emailsOpened: 0, emailsClicked: 0, emailsBounced: 0 };

  if (workflowDynastySlug) {
    const dynastySlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug, identityHeaders);
    if (dynastySlugs.length === 0 && !workflowSlugs) {
      return res.json(groupBy ? { groups: [] } : { stats: buildStatsObject(emptyStats), recipients: 0 });
    }
    workflowSlugs = workflowSlugs ? [...workflowSlugs, ...dynastySlugs] : dynastySlugs;
  }

  if (featureDynastySlug) {
    const dynastySlugs = await resolveFeatureDynastySlugs(featureDynastySlug, identityHeaders);
    if (dynastySlugs.length === 0 && !featureSlugs) {
      return res.json(groupBy ? { groups: [] } : { stats: buildStatsObject(emptyStats), recipients: 0 });
    }
    featureSlugs = featureSlugs ? [...featureSlugs, ...dynastySlugs] : dynastySlugs;
  }

  const conditions = buildStatsConditions({ ...filters, runIds, brandIds, workflowSlugs, featureSlugs });

  if (conditions.length === 0) {
    return res.status(400).json({
      error: "At least one filter is required (runIds, orgId, brandIds, campaignId, workflowSlugs, featureSlugs, workflowDynastySlug, or featureDynastySlug)",
    });
  }

  try {
    if (!groupBy) {
      // ─── Flat response ──────────────────────────────────────────────
      const sendings = await db
        .select({
          messageId: postmarkSendings.messageId,
          toEmail: postmarkSendings.toEmail,
          errorCode: postmarkSendings.errorCode,
        })
        .from(postmarkSendings)
        .where(and(...conditions));

      const messageIds = sendings
        .map((s) => s.messageId)
        .filter((id): id is string => id !== null);

      const eventMaps = await fetchEventMaps(messageIds);
      const recipientStats = computeRecipientStats(sendings, eventMaps);

      return res.json({
        stats: buildStatsObject(recipientStats),
        recipients: recipientStats.emailsSent,
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
    type SendingRow = { messageId: string | null; toEmail: string; errorCode: number | null; groupKey: string | null };
    let sendings: SendingRow[];

    if (isBrandGroupBy) {
      const rows = await db.execute<{ message_id: string | null; to_email: string; error_code: number | null; brand_id: string | null }>(
        sql`SELECT "postmark_sendings"."message_id", "postmark_sendings"."to_email", "postmark_sendings"."error_code", unnest("postmark_sendings"."brand_ids") AS brand_id
            FROM "postmark_sendings"
            ${conditions.length > 0 ? sql`WHERE ${and(...conditions)}` : sql``}`
      );
      sendings = rows.rows.map((r) => ({
        messageId: r.message_id,
        toEmail: r.to_email,
        errorCode: r.error_code,
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
          errorCode: postmarkSendings.errorCode,
          groupKey: dbColumn,
        })
        .from(postmarkSendings)
        .where(and(...conditions));
    }

    // Group sendings by dimension key (resolving to dynasty slug when needed)
    const grouped = new Map<string, SendingRow[]>();
    for (const s of sendings) {
      const rawKey = s.groupKey ?? "";
      const key = slugToDynastyMap ? (slugToDynastyMap.get(rawKey) ?? rawKey) : rawKey;
      let group = grouped.get(key);
      if (!group) {
        group = [];
        grouped.set(key, group);
      }
      group.push(s);
    }

    // Fetch all events once
    const allMessageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    const eventMaps = await fetchEventMaps(allMessageIds);

    const groups = Array.from(grouped.entries()).map(([key, groupSendings]) => {
      const recipientStats = computeRecipientStats(groupSendings, eventMaps);
      return {
        key,
        stats: buildStatsObject(recipientStats),
        recipients: recipientStats.emailsSent,
      };
    });

    return res.json({ groups });
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
