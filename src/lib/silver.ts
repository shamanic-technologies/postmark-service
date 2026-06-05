import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
  postmarkSubscriptionChanges,
  postmarkMessages,
} from "../db/schema";
import { recomputeLayer2 } from "./layer2";

export { recomputeLayer2 };
export type { Layer2Inputs, Layer2Result } from "./layer2";

/**
 * UPSERT the silver row for a single messageId by reading bronze tables.
 * Idempotent: re-running with the same bronze state produces the same silver row.
 * Called from webhook handlers after dump-to-bronze, and by the backfill script.
 *
 * If no bronze sending row exists for the messageId yet, the call is a no-op and logs a
 * warning. This handles the legitimate race where a webhook (e.g. Delivery) arrives before
 * the corresponding send completes — the next webhook for the same messageId will rebuild
 * silver from the now-complete bronze state.
 */
export async function upsertSilver(messageId: string): Promise<void> {
  const [sending] = await db
    .select()
    .from(postmarkSendings)
    .where(eq(postmarkSendings.messageId, messageId))
    .limit(1);

  if (!sending) {
    console.warn(`[postmark-service] upsertSilver skipped — no postmark_sendings row for messageId=${messageId}`);
    return;
  }

  const [delivery] = await db
    .select({ deliveredAt: postmarkDeliveries.deliveredAt, id: postmarkDeliveries.id })
    .from(postmarkDeliveries)
    .where(eq(postmarkDeliveries.messageId, messageId))
    .limit(1);

  const [bounce] = await db
    .select({ id: postmarkBounces.id, bouncedAt: postmarkBounces.bouncedAt })
    .from(postmarkBounces)
    .where(eq(postmarkBounces.messageId, messageId))
    .limit(1);

  // Openings/clicks are multi-row per message — aggregate existence + earliest time.
  const [opening] = await db
    .select({
      cnt: sql<number>`count(*)::int`,
      firstAt: sql<string | null>`min(${postmarkOpenings.receivedAt})`,
    })
    .from(postmarkOpenings)
    .where(eq(postmarkOpenings.messageId, messageId));

  const [click] = await db
    .select({
      cnt: sql<number>`count(*)::int`,
      firstAt: sql<string | null>`min(${postmarkLinkClicks.receivedAt})`,
    })
    .from(postmarkLinkClicks)
    .where(eq(postmarkLinkClicks.messageId, messageId));

  const [unsub] = await db
    .select({
      id: postmarkSubscriptionChanges.id,
      suppressSending: postmarkSubscriptionChanges.suppressSending,
      changedAt: postmarkSubscriptionChanges.changedAt,
    })
    .from(postmarkSubscriptionChanges)
    .where(eq(postmarkSubscriptionChanges.messageId, messageId))
    .limit(1);

  const toDate = (v: string | Date | null | undefined): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(v);

  const layer2 = recomputeLayer2({
    errorCode: sending.errorCode,
    hasDelivery: !!delivery,
    hasBounce: !!bounce,
    hasOpen: (opening?.cnt ?? 0) > 0,
    hasClick: (click?.cnt ?? 0) > 0,
    hasUnsubscribe: !!unsub && unsub.suppressSending === true,
    deliveredAt: delivery?.deliveredAt ?? null,
    openFirstAt: toDate(opening?.firstAt),
    clickFirstAt: toDate(click?.firstAt),
    bounceAt: toDate(bounce?.bouncedAt),
    unsubAt: toDate(unsub?.changedAt),
  });

  await db
    .insert(postmarkMessages)
    .values({
      messageId,
      toEmail: sending.toEmail,
      fromEmail: sending.fromEmail,
      subject: sending.subject,
      orgId: sending.orgId,
      userId: sending.userId,
      runId: sending.runId,
      campaignId: sending.campaignId,
      brandIds: sending.brandIds,
      featureSlug: sending.featureSlug,
      workflowSlug: sending.workflowSlug,
      leadId: sending.leadId,
      submittedAt: sending.submittedAt,
      errorCode: sending.errorCode,
      contacted: layer2.contacted,
      sent: layer2.sent,
      delivered: layer2.delivered,
      opened: layer2.opened,
      clicked: layer2.clicked,
      bounced: layer2.bounced,
      unsubscribed: layer2.unsubscribed,
      lastDeliveredAt: layer2.lastDeliveredAt,
      firstOpenedAt: layer2.firstOpenedAt,
      firstClickedAt: layer2.firstClickedAt,
      firstBouncedAt: layer2.firstBouncedAt,
      firstUnsubscribedAt: layer2.firstUnsubscribedAt,
      sourceAttribution: {
        sendingId: sending.id,
        deliveryId: delivery?.id ?? null,
        bounceId: bounce?.id ?? null,
        // openings/clicks are aggregated (multi-row); no single representative id.
        openingId: null,
        clickId: null,
        subscriptionChangeId: unsub?.id ?? null,
      },
      createdAt: sending.createdAt,
      lastRebuiltAt: new Date(),
    })
    .onConflictDoUpdate({
      target: postmarkMessages.messageId,
      set: {
        toEmail: sql`excluded.to_email`,
        fromEmail: sql`excluded.from_email`,
        subject: sql`excluded.subject`,
        orgId: sql`excluded.org_id`,
        userId: sql`excluded.user_id`,
        runId: sql`excluded.run_id`,
        campaignId: sql`excluded.campaign_id`,
        brandIds: sql`excluded.brand_ids`,
        featureSlug: sql`excluded.feature_slug`,
        workflowSlug: sql`excluded.workflow_slug`,
        leadId: sql`excluded.lead_id`,
        submittedAt: sql`excluded.submitted_at`,
        errorCode: sql`excluded.error_code`,
        contacted: sql`excluded.contacted`,
        sent: sql`excluded.sent`,
        delivered: sql`excluded.delivered`,
        opened: sql`excluded.opened`,
        clicked: sql`excluded.clicked`,
        bounced: sql`excluded.bounced`,
        unsubscribed: sql`excluded.unsubscribed`,
        lastDeliveredAt: sql`excluded.last_delivered_at`,
        firstOpenedAt: sql`excluded.first_opened_at`,
        firstClickedAt: sql`excluded.first_clicked_at`,
        firstBouncedAt: sql`excluded.first_bounced_at`,
        firstUnsubscribedAt: sql`excluded.first_unsubscribed_at`,
        sourceAttribution: sql`excluded.source_attribution`,
        lastRebuiltAt: sql`excluded.last_rebuilt_at`,
      },
    });
}
