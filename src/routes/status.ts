import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
} from "../db/schema";
import { eq, inArray, and, desc, SQL } from "drizzle-orm";
import { StatsRequestSchema, ByEmailRequestSchema } from "../schemas";

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
 * GET /status/by-lead/:leadId
 * Get the full status of the most recent email sent to a lead
 */
router.get("/status/by-lead/:leadId", async (req: Request, res: Response) => {
  const { leadId } = req.params;

  if (!leadId) {
    return res.status(400).json({ error: "leadId is required" });
  }

  try {
    // Get the most recent sending for this leadId
    const [sending] = await db
      .select()
      .from(postmarkSendings)
      .where(eq(postmarkSendings.leadId, leadId))
      .orderBy(desc(postmarkSendings.createdAt))
      .limit(1);

    if (!sending) {
      return res.status(404).json({ error: "No email found for lead" });
    }

    if (!sending.messageId) {
      return res.json({
        messageId: null,
        status: "sent",
        sending: {
          id: sending.id,
          to: sending.toEmail,
          from: sending.fromEmail,
          subject: sending.subject,
          submittedAt: sending.submittedAt,
          orgId: sending.orgId,
          runId: sending.runId,
        },
        delivery: null,
        bounce: null,
        openings: [],
        clicks: [],
      });
    }

    const messageId = sending.messageId;

    const [delivery] = await db
      .select()
      .from(postmarkDeliveries)
      .where(eq(postmarkDeliveries.messageId, messageId))
      .limit(1);

    const [bounce] = await db
      .select()
      .from(postmarkBounces)
      .where(eq(postmarkBounces.messageId, messageId))
      .limit(1);

    const openings = await db
      .select()
      .from(postmarkOpenings)
      .where(eq(postmarkOpenings.messageId, messageId));

    const clicks = await db
      .select()
      .from(postmarkLinkClicks)
      .where(eq(postmarkLinkClicks.messageId, messageId));

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
    console.error("Error getting lead status:", error);
    res.status(500).json({
      error: "Failed to get lead status",
      details: error.message,
    });
  }
});

/**
 * POST /status/by-email
 * Batch email delivery lookup for dedup (hot path)
 */
router.post("/status/by-email", async (req: Request, res: Response) => {
  const parsed = ByEmailRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { emails, campaignId } = parsed.data;

  try {
    const sendings = await db
      .select({
        toEmail: postmarkSendings.toEmail,
        messageId: postmarkSendings.messageId,
        leadId: postmarkSendings.leadId,
        deliveredAt: postmarkDeliveries.deliveredAt,
      })
      .from(postmarkSendings)
      .leftJoin(
        postmarkDeliveries,
        eq(postmarkSendings.messageId, postmarkDeliveries.messageId)
      )
      .where(
        and(
          eq(postmarkSendings.campaignId, campaignId),
          inArray(postmarkSendings.toEmail, emails)
        )
      );

    // Build map: email -> best result (any delivery wins, prefer non-null leadId)
    const emailMap = new Map<string, {
      sent: boolean;
      delivered: boolean;
      leadId: string | null;
      deliveredAt: Date | null;
    }>();

    for (const row of sendings) {
      const existing = emailMap.get(row.toEmail);
      if (!existing) {
        emailMap.set(row.toEmail, {
          sent: true,
          delivered: row.deliveredAt !== null,
          leadId: row.leadId,
          deliveredAt: row.deliveredAt,
        });
      } else {
        if (row.deliveredAt !== null) {
          existing.delivered = true;
          existing.deliveredAt = row.deliveredAt;
        }
        if (row.leadId && !existing.leadId) {
          existing.leadId = row.leadId;
        }
      }
    }

    const results = emails.map((email) => {
      const found = emailMap.get(email);
      return {
        email,
        sent: found?.sent ?? false,
        delivered: found?.delivered ?? false,
        leadId: found?.leadId ?? null,
        deliveredAt: found?.deliveredAt?.toISOString() ?? null,
      };
    });

    res.json({ campaignId, results });
  } catch (error: any) {
    console.error("Error checking email delivery status:", error);
    res.status(500).json({
      error: "Failed to check email delivery status",
      details: error.message,
    });
  }
});

// ─── Stats helpers ────────────────────────────────────────────────────────────

const GROUP_BY_COLUMN_MAP = {
  brandId: postmarkSendings.brandId,
  campaignId: postmarkSendings.campaignId,
  workflowName: postmarkSendings.workflowName,
  leadEmail: postmarkSendings.toEmail,
} as const;

function buildStatsConditions(data: {
  runIds?: string[];
  clerkOrgId?: string;
  brandId?: string;
  appId?: string;
  campaignId?: string;
  workflowName?: string;
}): SQL[] {
  const conditions: SQL[] = [];
  if (Array.isArray(data.runIds) && data.runIds.length > 0) {
    conditions.push(inArray(postmarkSendings.runId, data.runIds));
  }
  if (data.clerkOrgId) {
    conditions.push(eq(postmarkSendings.orgId, data.clerkOrgId));
  }
  if (data.brandId) {
    conditions.push(eq(postmarkSendings.brandId, data.brandId));
  }
  if (data.appId) {
    conditions.push(eq(postmarkSendings.appId, data.appId));
  }
  if (data.campaignId) {
    conditions.push(eq(postmarkSendings.campaignId, data.campaignId));
  }
  if (data.workflowName) {
    conditions.push(eq(postmarkSendings.workflowName, data.workflowName));
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

// ─── POST /stats ──────────────────────────────────────────────────────────────

/**
 * POST /stats
 * Get aggregated email stats with flexible filtering and optional groupBy
 */
router.post("/stats", async (req: Request, res: Response) => {
  const parsed = StatsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { groupBy, ...filters } = parsed.data;
  const conditions = buildStatsConditions(filters);

  if (conditions.length === 0) {
    return res.status(400).json({
      error: "At least one filter is required: runIds, clerkOrgId, brandId, appId, campaignId, or workflowName",
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
    const groupColumn = GROUP_BY_COLUMN_MAP[groupBy];

    const sendings = await db
      .select({
        messageId: postmarkSendings.messageId,
        toEmail: postmarkSendings.toEmail,
        groupKey: groupColumn,
      })
      .from(postmarkSendings)
      .where(and(...conditions));

    // Group sendings by dimension key
    const grouped = new Map<string, { messageIds: string[]; toEmails: Set<string>; count: number }>();
    for (const s of sendings) {
      const key = s.groupKey ?? "";
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
});

export default router;
