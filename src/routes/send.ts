import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";
import {
  ensureOrganization,
  createRun,
  updateRun,
  addCosts,
} from "../lib/runs-client";

const router = Router();

interface SendEmailRequest {
  orgId: string;
  runId: string;
  brandId: string;
  appId: string;
  campaignId: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  messageStream?: string;
  headers?: { name: string; value: string }[];
  metadata?: Record<string, string>;
  trackOpens?: boolean;
  trackLinks?: "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly";
}

/**
 * POST /send
 * Send an email via Postmark and record it in the database
 * BLOCKING: runs-service must succeed before email is sent
 */
router.post("/send", async (req: Request, res: Response) => {
  // #swagger.tags = ['Email Sending']
  // #swagger.summary = 'Send a single email'
  // #swagger.description = 'Send an email via Postmark and record it in the database. Runs-service integration is BLOCKING.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/SendEmailRequest" }
      }
    }
  } */
  /* #swagger.responses[200] = {
    description: "Email sent successfully",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/SendEmailResponse" }
      }
    }
  } */
  const body = req.body as SendEmailRequest;

  // Validate required fields
  if (!body.orgId || !body.runId || !body.brandId || !body.appId || !body.campaignId || !body.from || !body.to || !body.subject) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["orgId", "runId", "brandId", "appId", "campaignId", "from", "to", "subject"],
    });
  }

  if (!body.htmlBody && !body.textBody) {
    return res.status(400).json({
      error: "Either htmlBody or textBody is required",
    });
  }

  try {
    // 1. Create run in runs-service FIRST (BLOCKING)
    const runsOrgId = await ensureOrganization(body.orgId);
    const sendRun = await createRun({
      organizationId: runsOrgId,
      serviceName: "postmark-service",
      taskName: "email-send",
      parentRunId: body.runId,
    });

    try {
      // 2. Send email via Postmark
      const sendParams: SendEmailParams = {
        from: body.from,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        htmlBody: body.htmlBody,
        textBody: body.textBody,
        replyTo: body.replyTo,
        tag: body.tag,
        messageStream: body.messageStream,
        headers: body.headers,
        metadata: body.metadata,
        trackOpens: body.trackOpens,
        trackLinks: body.trackLinks,
      };

      const result = await sendEmail(sendParams);

      // 3. Record in database
      const [sending] = await db
        .insert(postmarkSendings)
        .values({
          messageId: result.messageId,
          toEmail: body.to,
          fromEmail: body.from,
          subject: body.subject,
          tag: body.tag,
          messageStream: body.messageStream || "broadcast",
          errorCode: result.errorCode,
          message: result.message,
          submittedAt: result.submittedAt,
          orgId: body.orgId,
          runId: sendRun.id,
          brandId: body.brandId,
          appId: body.appId,
          campaignId: body.campaignId,
          metadata: body.metadata,
        })
        .returning();

      // 4. Log costs and complete run
      if (result.success) {
        await addCosts(sendRun.id, [
          { costName: "postmark-email-send", quantity: 1 },
        ]);
        await updateRun(sendRun.id, "completed");

        res.status(200).json({
          success: true,
          messageId: result.messageId,
          submittedAt: result.submittedAt,
          sendingId: sending.id,
        });
      } else {
        await updateRun(sendRun.id, "failed", result.message);

        res.status(400).json({
          success: false,
          errorCode: result.errorCode,
          message: result.message,
          sendingId: sending.id,
        });
      }
    } catch (error: any) {
      // Email send or DB failed — mark run as failed
      await updateRun(sendRun.id, "failed", error.message);
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
router.post("/send/batch", async (req: Request, res: Response) => {
  // #swagger.tags = ['Email Sending']
  // #swagger.summary = 'Send batch emails'
  // #swagger.description = 'Send up to 500 emails in one request. Runs-service integration is BLOCKING for each email.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/BatchSendRequest" }
      }
    }
  } */
  /* #swagger.responses[200] = {
    description: "Batch results",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/BatchSendResponse" }
      }
    }
  } */
  const { emails } = req.body as { emails: SendEmailRequest[] };

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({
      error: "emails array is required",
    });
  }

  if (emails.length > 500) {
    return res.status(400).json({
      error: "Maximum 500 emails per batch",
    });
  }

  const results = [];

  for (const email of emails) {
    try {
      // 1. Create run in runs-service FIRST (BLOCKING)
      const runsOrgId = await ensureOrganization(email.orgId);
      const sendRun = await createRun({
        organizationId: runsOrgId,
        serviceName: "postmark-service",
        taskName: "email-send",
        parentRunId: email.runId,
      });

      try {
        // 2. Send email via Postmark
        const sendParams: SendEmailParams = {
          from: email.from,
          to: email.to,
          cc: email.cc,
          bcc: email.bcc,
          subject: email.subject,
          htmlBody: email.htmlBody,
          textBody: email.textBody,
          replyTo: email.replyTo,
          tag: email.tag,
          messageStream: email.messageStream,
          headers: email.headers,
          metadata: email.metadata,
          trackOpens: email.trackOpens,
          trackLinks: email.trackLinks,
        };

        const result = await sendEmail(sendParams);

        // 3. Record in database
        const [sending] = await db
          .insert(postmarkSendings)
          .values({
            messageId: result.messageId,
            toEmail: email.to,
            fromEmail: email.from,
            subject: email.subject,
            tag: email.tag,
            messageStream: email.messageStream || "broadcast",
            errorCode: result.errorCode,
            message: result.message,
            submittedAt: result.submittedAt,
            orgId: email.orgId,
            runId: sendRun.id,
            brandId: email.brandId,
            appId: email.appId,
            campaignId: email.campaignId,
            metadata: email.metadata,
          })
          .returning();

        // 4. Log costs and complete run
        if (result.success) {
          await addCosts(sendRun.id, [
            { costName: "postmark-email-send", quantity: 1 },
          ]);
          await updateRun(sendRun.id, "completed");
        } else {
          await updateRun(sendRun.id, "failed", result.message);
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
        await updateRun(sendRun.id, "failed", error.message);
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
