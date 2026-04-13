import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
} from "../db/schema";
import { inArray } from "drizzle-orm";

const router = Router();

/**
 * GET /public/performance/leaderboard
 *
 * Returns global workflow performance stats. API key only, no identity headers.
 * All metrics use unique-recipient counting with full implication chain.
 */
router.get("/performance/leaderboard", async (_req: Request, res: Response) => {
  try {
    const sendings = await db
      .select({
        messageId: postmarkSendings.messageId,
        toEmail: postmarkSendings.toEmail,
        errorCode: postmarkSendings.errorCode,
        workflowSlug: postmarkSendings.workflowSlug,
      })
      .from(postmarkSendings);

    // Group by workflowSlug
    const grouped = new Map<string, typeof sendings>();
    for (const s of sendings) {
      const key = s.workflowSlug ?? "";
      let group = grouped.get(key);
      if (!group) {
        group = [];
        grouped.set(key, group);
      }
      group.push(s);
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
      .filter(([key]) => key !== "") // exclude sendings with no workflowSlug
      .map(([key, groupSendings]) => {
        // Count by unique recipient with implications
        const byRecipient = new Map<string, typeof groupSendings>();
        for (const s of groupSendings) {
          let recip = byRecipient.get(s.toEmail);
          if (!recip) {
            recip = [];
            byRecipient.set(s.toEmail, recip);
          }
          recip.push(s);
        }

        let emailsContacted = 0;
        let emailsSent = 0;
        let emailsDelivered = 0;
        let emailsOpened = 0;
        let emailsClicked = 0;
        let emailsBounced = 0;

        for (const [, msgs] of byRecipient) {
          let rSent = false;
          let rDelivered = false;
          let rOpened = false;
          let rClicked = false;
          let rBounced = false;

          for (const s of msgs) {
            const mid = s.messageId;
            const hasDelivery = mid ? deliveredSet.has(mid) : false;
            const hasBounce = mid ? bouncedSet.has(mid) : false;
            const hasOpen = mid ? openedSet.has(mid) : false;
            const hasClick = mid ? clickedSet.has(mid) : false;

            // Implication chain
            if (hasClick) rClicked = true;
            if (hasOpen || hasClick) rOpened = true;
            if ((hasDelivery || hasOpen || hasClick) && !hasBounce) rDelivered = true;
            if (s.errorCode === 0 || hasDelivery || hasOpen || hasClick || hasBounce) rSent = true;
            if (hasBounce) rBounced = true;
          }

          emailsContacted++;
          if (rSent) emailsSent++;
          if (rDelivered) emailsDelivered++;
          if (rOpened) emailsOpened++;
          if (rClicked) emailsClicked++;
          if (rBounced) emailsBounced++;
        }

        return {
          workflowSlug: key,
          emailsContacted,
          emailsSent,
          emailsDelivered,
          emailsOpened,
          emailsClicked,
          emailsBounced,
          openRate: emailsSent > 0 ? emailsOpened / emailsSent : 0,
          clickRate: emailsSent > 0 ? emailsClicked / emailsSent : 0,
          bounceRate: emailsSent > 0 ? emailsBounced / emailsSent : 0,
          deliveryRate: emailsSent > 0 ? emailsDelivered / emailsSent : 0,
        };
      })
      .sort((a, b) => b.emailsSent - a.emailsSent);

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
