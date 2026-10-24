import { messageOf } from "../lib/db-error.js";
import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { eq, and, ne } from "drizzle-orm";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";
import { getOrgKey, getStreamId, getFromAddress } from "../lib/key-client";
import { authorizeCredits } from "../lib/billing-client";
import { creditRefusalBody } from "../lib/credit-refusal";
import { SendEmailRequestSchema, BatchSendRequestSchema } from "../schemas";
import { upsertSilver } from "../lib/silver";
import { resolvePayer } from "../lib/payer";
import { openSendLedger } from "../lib/send-ledger";
import { resolveOutcomeSubject, scheduleOutcomeDeclaration } from "../lib/outcome-declaration";
import { sendSupportFor } from "../lib/send-support";

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

    // 2. Resolve message stream from key-service. Broadcast unless the caller asked
    //    for the transactional stream (person-to-person mail: no List-Unsubscribe).
    const messageStream = await getStreamId(orgId, userId, body.stream ?? "broadcast", caller, trackingHeaders);

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
        return res.status(402).json(creditRefusalBody(auth));
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
      support: sendSupportFor(resolveOutcomeSubject({ outcomeSubject: body.outcomeSubject, leadId: body.leadId })),
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
      const outcomeSubject = resolveOutcomeSubject({ outcomeSubject: body.outcomeSubject, leadId: body.leadId });

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
          // The caller's own run (inbound x-run-id). run_id is the child this send
          // minted, so only this column can answer for the caller's whole operation.
          parentRunId: parentRunId || null,
          brandIds: brandIds ?? null,
          campaignId,
          featureSlug,
          workflowSlug,
          audienceId,
          payer,
          leadId: body.leadId,
          // Only a send that went out produced anything (a failure is never an outcome).
          ...(result.success && outcomeSubject && {
            outcomeSubjectService: outcomeSubject.subjectService,
            outcomeSubjectId: outcomeSubject.subjectId,
            consumedOutcomeKeys: body.consumedOutcomeKeys ?? null,
          }),
          metadata: body.metadata,
        })
        .returning();

      // 7b. Initialize silver row so subsequent webhooks UPSERT against an existing row.
      if (result.messageId) await upsertSilver(result.messageId);

      // 8. Log costs and complete run
      if (result.success) {
        await ledger.addSendCost(decryptedKey.keySource);
        await ledger.complete();

        // 8b. Declare what the send produced (off the request path, never blocking).
        if (outcomeSubject) {
          scheduleOutcomeDeclaration({
            sendingId: sending.id,
            runId: sendRunId,
            payer,
            orgId,
            ...outcomeSubject,
            consumedOutcomeKeys: body.consumedOutcomeKeys ?? null,
          });
        }

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
      await ledger.fail(messageOf(error));
      throw error;
    }
  } catch (error: any) {
    console.error(
      `[send] Failed to process email — to=${req.body?.to} error="${messageOf(error)}"`
    );
    res.status(500).json({
      error: "Failed to send email",
      details: messageOf(error),
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
  let broadcastStream: string;
  // Resolved only when at least one email asks for it, so a batch that never does
  // makes exactly the key-service calls it made before the option existed.
  let transactionalStream: string | undefined;
  let defaultFrom: string;
  try {
    const batchCaller = { method: "POST" as const, path: "/send/batch" };
    const decryptedKey = await getOrgKey(orgId, userId, "postmark", batchCaller, trackingHeaders);
    keySource = decryptedKey.keySource;
    broadcastStream = await getStreamId(orgId, userId, "broadcast", batchCaller, trackingHeaders);
    if (emails.some((e) => e.stream === "transactional")) {
      transactionalStream = await getStreamId(orgId, userId, "transactional", batchCaller, trackingHeaders);
    }
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
        return res.status(402).json(creditRefusalBody(auth));
      }
    }
  } catch (error: any) {
    console.error(
      `[send/batch] Failed to resolve keys — error="${messageOf(error)}"`
    );
    return res.status(500).json({
      error: "Failed to resolve Postmark keys",
      details: messageOf(error),
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
        support: sendSupportFor(resolveOutcomeSubject({ outcomeSubject: email.outcomeSubject, leadId: email.leadId })),
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
        const messageStream = email.stream === "transactional" ? transactionalStream! : broadcastStream;
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
        const outcomeSubject = resolveOutcomeSubject({ outcomeSubject: email.outcomeSubject, leadId: email.leadId });

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
            parentRunId: parentRunId || null,
            brandIds: emailBrandIds ?? null,
            campaignId: emailCampaignId,
            featureSlug: emailFeatureSlug,
            workflowSlug: emailWorkflowSlug,
            audienceId: emailAudienceId,
            payer: emailPayer,
            leadId: email.leadId,
            ...(result.success && outcomeSubject && {
              outcomeSubjectService: outcomeSubject.subjectService,
              outcomeSubjectId: outcomeSubject.subjectId,
              consumedOutcomeKeys: email.consumedOutcomeKeys ?? null,
            }),
            metadata: email.metadata,
          })
          .returning();

        // 3b. Initialize silver row so subsequent webhooks UPSERT against an existing row.
        if (result.messageId) await upsertSilver(result.messageId);

        // 4. Log costs and complete run
        if (result.success) {
          await ledger.addSendCost(keySource);
          await ledger.complete();
          if (outcomeSubject) {
            scheduleOutcomeDeclaration({
              sendingId: sending.id,
              runId: sendRunId,
              payer: emailPayer,
              orgId,
              ...outcomeSubject,
              consumedOutcomeKeys: email.consumedOutcomeKeys ?? null,
            });
          }
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
        await ledger.fail(messageOf(error));
        throw error;
      }
    } catch (error: any) {
      results.push({
        to: email.to,
        success: false,
        error: messageOf(error),
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
