import { Router, Request, Response } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";

const router = Router();

interface LeaderboardRow {
  workflow_slug: string;
  recipients_contacted: number;
  recipients_sent: number;
  recipients_delivered: number;
  recipients_opened: number;
  recipients_clicked: number;
  recipients_bounced: number;
  [key: string]: unknown;
}

/**
 * GET /public/performance/leaderboard
 *
 * Returns global workflow performance stats. API key only, no identity headers.
 * All metrics use unique-recipient counting; the Layer 2 implication chain is already
 * baked into the silver `postmark_messages` booleans.
 */
router.get("/performance/leaderboard", async (_req: Request, res: Response) => {
  try {
    const { rows } = await db.execute<LeaderboardRow>(sql`
      SELECT
        "workflow_slug",
        COUNT(DISTINCT "to_email") FILTER (WHERE "contacted")::int AS recipients_contacted,
        COUNT(DISTINCT "to_email") FILTER (WHERE "sent")::int AS recipients_sent,
        COUNT(DISTINCT "to_email") FILTER (WHERE "delivered")::int AS recipients_delivered,
        COUNT(DISTINCT "to_email") FILTER (WHERE "opened")::int AS recipients_opened,
        COUNT(DISTINCT "to_email") FILTER (WHERE "clicked")::int AS recipients_clicked,
        COUNT(DISTINCT "to_email") FILTER (WHERE "bounced")::int AS recipients_bounced
      FROM "postmark_messages"
      WHERE "workflow_slug" IS NOT NULL
      GROUP BY "workflow_slug"
      ORDER BY recipients_sent DESC
    `);

    const workflows = rows.map((r) => {
      const emailsSent = r.recipients_sent;
      return {
        workflowSlug: r.workflow_slug,
        emailsContacted: r.recipients_contacted,
        emailsSent,
        emailsDelivered: r.recipients_delivered,
        emailsOpened: r.recipients_opened,
        emailsClicked: r.recipients_clicked,
        emailsBounced: r.recipients_bounced,
        openRate: emailsSent > 0 ? r.recipients_opened / emailsSent : 0,
        clickRate: emailsSent > 0 ? r.recipients_clicked / emailsSent : 0,
        bounceRate: emailsSent > 0 ? r.recipients_bounced / emailsSent : 0,
        deliveryRate: emailsSent > 0 ? r.recipients_delivered / emailsSent : 0,
      };
    });

    res.json({ workflows });
  } catch (error: any) {
    console.error("[postmark-service] Error getting leaderboard:", error);
    res.status(500).json({
      error: "Failed to get leaderboard",
      details: error.message,
    });
  }
});

export default router;
