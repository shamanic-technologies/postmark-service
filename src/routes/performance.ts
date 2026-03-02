import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
} from "../db/schema";
import { inArray, eq, and, SQL } from "drizzle-orm";

const router = Router();

/**
 * GET /performance/leaderboard
 *
 * Returns workflow performance stats. Global by default.
 * Auth headers (x-org-id, x-user-id) are NEVER used for filtering.
 * Optional query params for explicit filtering:
 *   ?appId=xxx — filter by application ID
 */
router.get("/performance/leaderboard", async (req: Request, res: Response) => {
  try {
    const appId = req.query.appId as string | undefined;

    // Build optional filters from query params only (never from headers)
    const conditions: SQL[] = [];
    if (appId) {
      conditions.push(eq(postmarkSendings.appId, appId));
    }

    const sendings = await db
      .select({
        messageId: postmarkSendings.messageId,
        workflowName: postmarkSendings.workflowName,
      })
      .from(postmarkSendings)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Group by workflowName
    const grouped = new Map<string, { messageIds: string[]; count: number }>();
    for (const s of sendings) {
      const key = s.workflowName ?? "";
      let group = grouped.get(key);
      if (!group) {
        group = { messageIds: [], count: 0 };
        grouped.set(key, group);
      }
      group.count++;
      if (s.messageId) group.messageIds.push(s.messageId);
    }

    const allMessageIds = sendings
      .map((s) => s.messageId)
      .filter((id): id is string => id !== null);

    // Fetch all events in parallel
    const [allDeliveries, allOpenings, allClicks, allBounces] =
      allMessageIds.length > 0
        ? await Promise.all([
            db
              .select({ messageId: postmarkDeliveries.messageId })
              .from(postmarkDeliveries)
              .where(inArray(postmarkDeliveries.messageId, allMessageIds)),
            db
              .select({ messageId: postmarkOpenings.messageId })
              .from(postmarkOpenings)
              .where(inArray(postmarkOpenings.messageId, allMessageIds)),
            db
              .select({ messageId: postmarkLinkClicks.messageId })
              .from(postmarkLinkClicks)
              .where(inArray(postmarkLinkClicks.messageId, allMessageIds)),
            db
              .select({ messageId: postmarkBounces.messageId })
              .from(postmarkBounces)
              .where(inArray(postmarkBounces.messageId, allMessageIds)),
          ])
        : [[], [], [], []];

    // Build lookup sets
    const deliveredSet = new Set(allDeliveries.map((d) => d.messageId));
    const openedSet = new Set(allOpenings.map((o) => o.messageId));
    const clickedSet = new Set(allClicks.map((c) => c.messageId));
    const bouncedSet = new Set(allBounces.map((b) => b.messageId));

    const workflows = Array.from(grouped.entries())
      .filter(([key]) => key !== "") // exclude sendings with no workflowName
      .map(([key, group]) => {
        const delivered = group.messageIds.filter((id) => deliveredSet.has(id)).length;
        const opened = group.messageIds.filter((id) => openedSet.has(id)).length;
        const clicked = group.messageIds.filter((id) => clickedSet.has(id)).length;
        const bounced = group.messageIds.filter((id) => bouncedSet.has(id)).length;

        return {
          workflowName: key,
          emailsSent: group.count,
          emailsDelivered: delivered,
          emailsOpened: opened,
          emailsClicked: clicked,
          emailsBounced: bounced,
          openRate: group.count > 0 ? opened / group.count : 0,
          clickRate: group.count > 0 ? clicked / group.count : 0,
          bounceRate: group.count > 0 ? bounced / group.count : 0,
          deliveryRate: group.count > 0 ? delivered / group.count : 0,
        };
      })
      .sort((a, b) => b.emailsSent - a.emailsSent);

    res.json({ workflows });
  } catch (error: any) {
    console.error("Error getting leaderboard:", error);
    res.status(500).json({
      error: "Failed to get leaderboard",
      details: error.message,
    });
  }
});

export default router;
