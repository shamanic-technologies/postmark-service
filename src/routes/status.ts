import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
} from "../db/schema";
import { eq, inArray, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /status/:messageId
 * Get the full status of an email by its Postmark message ID
 */
router.get("/status/:messageId", async (req: Request, res: Response) => {
  // #swagger.tags = ['Email Status']
  // #swagger.summary = 'Get email status'
  // #swagger.description = 'Get the full delivery status of an email by its Postmark message ID'
  /* #swagger.responses[200] = {
    description: "Email status",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/EmailStatus" }
      }
    }
  } */
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
  // #swagger.tags = ['Email Status']
  // #swagger.summary = 'Get emails by organization'
  // #swagger.description = 'Get recent emails for an organization'
  // #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Max results (default: 50)' }
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
  // #swagger.tags = ['Email Status']
  // #swagger.summary = 'Get emails by run'
  // #swagger.description = 'Get all emails for a specific run'
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

    // Get stats
    const messageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    // This is a simplified approach - for production, you'd want to join these
    // or use a more efficient query

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
 * POST /stats
 * Get aggregated email stats for multiple run IDs
 * Body: { runIds: string[] }
 */
router.post("/stats", async (req: Request, res: Response) => {
  // #swagger.tags = ['Email Status']
  // #swagger.summary = 'Get aggregated stats'
  // #swagger.description = 'Get aggregated email stats for multiple run IDs'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/StatsRequest" }
      }
    }
  } */
  /* #swagger.responses[200] = {
    description: "Aggregated stats",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/StatsResponse" }
      }
    }
  } */
  const { runIds } = req.body;

  if (!runIds || !Array.isArray(runIds)) {
    return res.status(400).json({ error: "runIds array required" });
  }

  if (runIds.length === 0) {
    return res.json({
      stats: {
        emailsSent: 0,
        emailsOpened: 0,
        emailsClicked: 0,
        emailsReplied: 0,
        emailsBounced: 0,
        repliesWillingToMeet: 0,
        repliesInterested: 0,
        repliesNotInterested: 0,
        repliesOutOfOffice: 0,
        repliesUnsubscribe: 0,
      },
    });
  }

  try {
    // Count successful sends
    const sendings = await db
      .select({ id: postmarkSendings.id, messageId: postmarkSendings.messageId })
      .from(postmarkSendings)
      .where(inArray(postmarkSendings.runId, runIds));

    const messageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    let emailsOpened = 0;
    let emailsClicked = 0;
    let emailsBounced = 0;

    if (messageIds.length > 0) {
      // Count unique opens (first open per message)
      const openings = await db
        .select({ messageId: postmarkOpenings.messageId })
        .from(postmarkOpenings)
        .where(inArray(postmarkOpenings.messageId, messageIds));
      emailsOpened = new Set(openings.map((o) => o.messageId)).size;

      // Count unique clicks
      const clicks = await db
        .select({ messageId: postmarkLinkClicks.messageId })
        .from(postmarkLinkClicks)
        .where(inArray(postmarkLinkClicks.messageId, messageIds));
      emailsClicked = new Set(clicks.map((c) => c.messageId)).size;

      // Count bounces
      const bounces = await db
        .select({ messageId: postmarkBounces.messageId })
        .from(postmarkBounces)
        .where(inArray(postmarkBounces.messageId, messageIds));
      emailsBounced = bounces.length;
    }

    // Reply tracking is not in postmark-service yet
    // These will come from reply-qualification-service in the future
    res.json({
      stats: {
        emailsSent: sendings.length,
        emailsOpened,
        emailsClicked,
        emailsReplied: 0, // TODO: integrate with reply tracking
        emailsBounced,
        repliesWillingToMeet: 0,
        repliesInterested: 0,
        repliesNotInterested: 0,
        repliesOutOfOffice: 0,
        repliesUnsubscribe: 0,
      },
    });
  } catch (error: any) {
    console.error("Error getting stats:", error);
    res.status(500).json({
      error: "Failed to get stats",
      details: error.message,
    });
  }
});

export default router;
