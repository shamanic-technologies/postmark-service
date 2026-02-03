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
 */
router.post("/send", async (req: Request, res: Response) => {
  const body = req.body as SendEmailRequest;

  // Validate required fields
  if (!body.orgId || !body.runId || !body.from || !body.to || !body.subject) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["orgId", "runId", "from", "to", "subject"],
    });
  }

  if (!body.htmlBody && !body.textBody) {
    return res.status(400).json({
      error: "Either htmlBody or textBody is required",
    });
  }

  try {
    // Send email via Postmark
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

    // Record in database
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
        runId: body.runId,
        metadata: body.metadata,
      })
      .returning();

    // Track run in runs-service (non-blocking — email is already sent)
    if (result.success) {
      try {
        const runsOrgId = await ensureOrganization(body.orgId);
        const sendRun = await createRun({
          organizationId: runsOrgId,
          serviceName: "postmark-service",
          taskName: "email-send",
          parentRunId: body.runId,
        });
        await addCosts(sendRun.id, [
          { costName: "postmark-email-send", quantity: 1 },
        ]);
        await updateRun(sendRun.id, "completed");
      } catch (runsError: any) {
        console.error(
          `[runs-service] Failed to track email send — orgId=${body.orgId} runId=${body.runId} to=${body.to} error="${runsError.message}". Email was delivered successfully; only run tracking is affected. Check RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY.`
        );
      }
    }

    if (result.success) {
      res.status(200).json({
        success: true,
        messageId: result.messageId,
        submittedAt: result.submittedAt,
        sendingId: sending.id,
      });
    } else {
      res.status(400).json({
        success: false,
        errorCode: result.errorCode,
        message: result.message,
        sendingId: sending.id,
      });
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
 */
router.post("/send/batch", async (req: Request, res: Response) => {
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

      // Record in database
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
          runId: email.runId,
          metadata: email.metadata,
        })
        .returning();

      // Track run in runs-service (non-blocking — email is already sent)
      if (result.success) {
        try {
          const runsOrgId = await ensureOrganization(email.orgId);
          const sendRun = await createRun({
            organizationId: runsOrgId,
            serviceName: "postmark-service",
            taskName: "email-send",
            parentRunId: email.runId,
          });
          await addCosts(sendRun.id, [
            { costName: "postmark-email-send", quantity: 1 },
          ]);
          await updateRun(sendRun.id, "completed");
        } catch (runsError: any) {
          console.error(
            `[runs-service] Failed to track email send — orgId=${email.orgId} runId=${email.runId} to=${email.to} error="${runsError.message}". Email was delivered successfully; only run tracking is affected. Check RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY.`
          );
        }
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
