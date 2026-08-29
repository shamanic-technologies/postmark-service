import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";
import { getOrgKey, getStreamId, getFromAddress } from "../lib/key-client";
import { authorizeCredits } from "../lib/billing-client";
import { SendEmailRequestSchema, BatchSendRequestSchema } from "../schemas";
import { upsertSilver } from "../lib/silver";
import { resolvePayer } from "../lib/payer";
import { openSendLedger } from "../lib/send-ledger";

const router = Router();


/**
 * POST /send
 * Send an email via Postmark and record it in the database
 * BLOCKING: runs-service must succeed before email is sent
 */
router.post("/send", async (req: Request & { orgContext?: import("../middleware/serviceAuth").OrgContext }, res: Response) => {
  const parsed = SendEmailRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const body = parsed.data;
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parentRunId = req.headers["x-run-id"] as string;

  // Workflow tracking headers (body takes priority, headers are fallback)
  const campaignId = body.campaignId ?? (req.headers["x-campaign-id"] as string | undefined);
  const headerBrandIds = String(req.headers["x-brand-id"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const brandIds = headerBrandIds.length > 0 ? headerBrandIds : undefined;
  const featureSlug = body.featureSlug ?? (req.headers["x-feature-slug"] as string | undefined);
  const workflowSlug = body.workflowSlug ?? (req.headers["x-workflow-slug"] as string | undefined);
  const audienceId = body.audienceId ?? (req.headers["x-audience-id"] as string | undefined);
  const trackingHeaders: Record<string, string> = {};
  if (campaignId) trackingHeaders["x-campaign-id"] = campaignId;
  if (brandIds && brandIds.length > 0) trackingHeaders["x-brand-id"] = brandIds.join(",");
  if (featureSlug) trackingHeaders["x-feature-slug"] = featureSlug;
  if (workflowSlug) trackingHeaders["x-workflow-slug"] = workflowSlug;
  if (audienceId) trackingHeaders["x-audience-id"] = audienceId;

  try {
    // 1. Resolve key from key-service (get keySource for cost tracking)
    const caller = { method: "POST" as const, path: "/send" };
    const decryptedKey = await getOrgKey(orgId, userId, "postmark", caller, trackingHeaders);

    // 2. Resolve message stream from key-service
    const messageStream = await getStreamId(orgId, userId, "broadcast", caller, trackingHeaders);

    // 3. Resolve "from" address: use caller-provided value, or fall back to key-service
    const fromAddress = body.from ?? await getFromAddress(orgId, userId, caller, trackingHeaders);

    // 4. Credit authorization. Only an org-paid send on a platform key is gated:
    //    a platform-paid send costs the org nothing, so there is nothing to
    //    authorize — and authorizing it is what let a billing notification
    //    re-enter the charge path it was reporting on (2026-08-29).
    const payer = resolvePayer({ payer: body.payer, tag: body.tag });
    if (decryptedKey.keySource === "platform" && payer === "org") {
      const auth = await authorizeCredits({
        orgId,
        userId,
        runId: parentRunId,
        items: [{ costName: "postmark-email-send", quantity: 1 }],
        trackingHeaders,
      });
      if (!auth.sufficient) {
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
      }
    }

    // 5. Open the run ledger against whoever pays (BLOCKING)
    const ledger = await openSendLedger({
      payer,
      orgId,
      userId,
      parentRunId,
      brandId: brandIds?.[0],
      campaignId,
      featureSlug,
      workflowSlug,
      audienceId,
      trackingHeaders,
    });
    const sendRunId = ledger.runId;

    try {
      // 6. Guard: reject conflicting leadId for this email
      if (body.leadId) {
        const [existing] = await db
          .select({ leadId: postmarkSendings.leadId })
          .from(postmarkSendings)
          .where(
            and(
              eq(postmarkSendings.toEmail, body.to),
              ne(postmarkSendings.leadId, body.leadId),
            )
          )
          .limit(1);

        if (existing) {
          await ledger.fail("leadId conflict");
          return res.status(400).json({
            error: "leadId conflict",
            details: `Email ${body.to} already has leadId=${existing.leadId} in the database, but this request sent leadId=${body.leadId}`,
          });
        }
      }

      // 7. Send email via Postmark
      const sendParams: SendEmailParams = {
        from: fromAddress,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        htmlBody: body.htmlBody,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        messageStream,
        headers: body.headers,
        metadata: body.metadata,
        trackOpens: body.trackOpens,
        trackLinks: body.trackLinks,
        orgId,
        userId,
        caller,
      };

      const result = await sendEmail(sendParams);

      // 7. Record in database
      const [sending] = await db
        .insert(postmarkSendings)
        .values({
          messageId: result.messageId,
          toEmail: body.to,
          fromEmail: fromAddress,
          subject: body.subject,
          tag: body.tag,
          messageStream,
          errorCode: result.errorCode,
          message: result.message,
          submittedAt: result.submittedAt,
          orgId,
          userId,
          runId: sendRunId,
          brandIds: brandIds ?? null,
          campaignId,
          featureSlug,
          workflowSlug,
          audienceId,
          payer,
          leadId: body.leadId,
          metadata: body.metadata,
        })
        .returning();

      // 7b. Initialize silver row so subsequent webhooks UPSERT against an existing row.
      if (result.messageId) await upsertSilver(result.messageId);

      // 8. Log costs and complete run
      if (result.success) {
        await ledger.addSendCost(decryptedKey.keySource);
        await ledger.complete();

        res.status(200).json({
          success: true,
          messageId: result.messageId,
          submittedAt: result.submittedAt,
          sendingId: sending.id,
        });
      } else {
        await ledger.fail(result.message);

        res.status(400).json({
          success: false,
          errorCode: result.errorCode,
          message: result.message,
          sendingId: sending.id,
        });
      }
    } catch (error: any) {
      // Email send or DB failed — mark run as failed
      await ledger.fail(error.message);
      throw error;
    }
  } catch (error: any) {
    console.error(
      `[send] Failed to process email — to=${req.body?.to} error="${error.message}"`
    );
    res.status(500).json({
      error: "Failed to send email",
      details: error.message,
    });
  }
});

/**
 * POST /send/batch
 * Send multiple emails in a batch
 * BLOCKING: runs-service must succeed before each email is sent
 */
router.post("/send/batch", async (req: Request & { orgContext?: import("../middleware/serviceAuth").OrgContext }, res: Response) => {
  const parsed = BatchSendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { emails } = parsed.data;
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parentRunId = req.headers["x-run-id"] as string;

  // Workflow tracking headers from request (used as fallback for per-email values)
  const headerCampaignId = req.headers["x-campaign-id"] as string | undefined;
  const headerBrandIds = String(req.headers["x-brand-id"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const headerFeatureSlug = req.headers["x-feature-slug"] as string | undefined;
  const headerWorkflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const headerAudienceId = req.headers["x-audience-id"] as string | undefined;
  const trackingHeaders: Record<string, string> = {};
  if (headerCampaignId) trackingHeaders["x-campaign-id"] = headerCampaignId;
  if (headerBrandIds.length > 0) trackingHeaders["x-brand-id"] = headerBrandIds.join(",");
  if (headerFeatureSlug) trackingHeaders["x-feature-slug"] = headerFeatureSlug;
  if (headerWorkflowSlug) trackingHeaders["x-workflow-slug"] = headerWorkflowSlug;
  if (headerAudienceId) trackingHeaders["x-audience-id"] = headerAudienceId;

  const results = [];

  // Resolve key, stream, and default from once for the batch (same org for all emails)
  let keySource: "platform" | "org";
  let messageStream: string;
  let defaultFrom: string;
  try {
    const batchCaller = { method: "POST" as const, path: "/send/batch" };
    const decryptedKey = await getOrgKey(orgId, userId, "postmark", batchCaller, trackingHeaders);
    keySource = decryptedKey.keySource;
    messageStream = await getStreamId(orgId, userId, "broadcast", batchCaller, trackingHeaders);
    defaultFrom = await getFromAddress(orgId, userId, batchCaller, trackingHeaders);

    // Credit authorization for the batch (platform keys only). Only the org-paid
    // emails are authorized; platform-paid ones cost the org nothing, so a batch
    // made entirely of them skips the gate.
    const billableCount = emails.filter(
      (e) => resolvePayer({ payer: e.payer, tag: e.tag }) === "org"
    ).length;
    if (keySource === "platform" && billableCount > 0) {
      const auth = await authorizeCredits({
        orgId,
        userId,
        runId: parentRunId,
        items: [{ costName: "postmark-email-send", quantity: billableCount }],
        trackingHeaders,
      });
      if (!auth.sufficient) {
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: auth.balance_cents,
          required_cents: auth.required_cents,
        });
      }
    }
  } catch (error: any) {
    console.error(
      `[send/batch] Failed to resolve keys — error="${error.message}"`
    );
    return res.status(500).json({
      error: "Failed to resolve Postmark keys",
      details: error.message,
    });
  }

  for (const email of emails) {
    try {
      // Per-email tracking: body takes priority for campaignId/featureSlug/workflowSlug, brandIds from header only
      const emailCampaignId = email.campaignId ?? headerCampaignId;
      const emailBrandIds = headerBrandIds.length > 0 ? headerBrandIds : undefined;
      const emailFeatureSlug = email.featureSlug ?? headerFeatureSlug;
      const emailWorkflowSlug = email.workflowSlug ?? headerWorkflowSlug;
      const emailAudienceId = email.audienceId ?? headerAudienceId;

      // 1. Open the run ledger against whoever pays for this email (BLOCKING)
      const emailPayer = resolvePayer({ payer: email.payer, tag: email.tag });
      const ledger = await openSendLedger({
        payer: emailPayer,
        orgId,
        userId,
        parentRunId,
        brandId: emailBrandIds?.[0],
        campaignId: emailCampaignId,
        featureSlug: emailFeatureSlug,
        workflowSlug: emailWorkflowSlug,
        audienceId: emailAudienceId,
        trackingHeaders,
      });
      const sendRunId = ledger.runId;

      try {
        // 2. Guard: reject conflicting leadId for this email
        if (email.leadId) {
          const [existing] = await db
            .select({ leadId: postmarkSendings.leadId })
            .from(postmarkSendings)
            .where(
              and(
                eq(postmarkSendings.toEmail, email.to),
                ne(postmarkSendings.leadId, email.leadId),
              )
            )
            .limit(1);

          if (existing) {
            await ledger.fail("leadId conflict");
            throw new Error(`leadId conflict: email ${email.to} already has leadId=${existing.leadId}, but this request sent leadId=${email.leadId}`);
          }
        }

        // 3. Send email via Postmark
        const batchCaller = { method: "POST" as const, path: "/send/batch" };
        const fromAddress = email.from ?? defaultFrom;
        const sendParams: SendEmailParams = {
          from: fromAddress,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          htmlBody: email.htmlBody,
          textBody: email.textBody,
          replyTo: email.replyTo,
          tag: email.tag,
          messageStream,
          headers: email.headers,
          metadata: email.metadata,
          trackOpens: email.trackOpens,
          trackLinks: email.trackLinks,
          orgId,
          userId,
          caller: batchCaller,
        };

        const result = await sendEmail(sendParams);

        // 3. Record in database
        const [sending] = await db
          .insert(postmarkSendings)
          .values({
            messageId: result.messageId,
            toEmail: email.to,
            fromEmail: fromAddress,
            subject: email.subject,
            tag: email.tag,
            messageStream,
            errorCode: result.errorCode,
            message: result.message,
            submittedAt: result.submittedAt,
            orgId,
            userId,
            runId: sendRunId,
            brandIds: emailBrandIds ?? null,
            campaignId: emailCampaignId,
            featureSlug: emailFeatureSlug,
            workflowSlug: emailWorkflowSlug,
            audienceId: emailAudienceId,
            payer: emailPayer,
            leadId: email.leadId,
            metadata: email.metadata,
          })
          .returning();

        // 3b. Initialize silver row so subsequent webhooks UPSERT against an existing row.
        if (result.messageId) await upsertSilver(result.messageId);

        // 4. Log costs and complete run
        if (result.success) {
          await ledger.addSendCost(keySource);
          await ledger.complete();
        } else {
          await ledger.fail(result.message);
        }

        results.push({
          to: email.to,
          success: result.success,
          messageId: result.messageId,
          sendingId: sending.id,
          errorCode: result.errorCode,
          message: result.message,
        });
      } catch (error: any) {
        // Email send or DB failed — mark run as failed
        await ledger.fail(error.message);
        throw error;
      }
    } catch (error: any) {
      results.push({
        to: email.to,
        success: false,
        error: error.message,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  res.status(200).json({
    total: emails.length,
    successCount,
    failCount,
    results,
  });
});

export default router;
