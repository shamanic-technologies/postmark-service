import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";

const router = Router();

interface SendEmailRequest {
  orgId?: string;
  campaignRunId?: string;
  from: string;
  to: string;
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
  if (!body.from || !body.to || !body.subject) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["from", "to", "subject"],
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
        messageStream: body.messageStream || "outbound",
        errorCode: result.errorCode,
        message: result.message,
        submittedAt: result.submittedAt,
        orgId: body.orgId,
        campaignRunId: body.campaignRunId,
        metadata: body.metadata,
      })
      .returning();

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
    console.error("Error sending email:", error);
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
          messageStream: email.messageStream || "outbound",
          errorCode: result.errorCode,
          message: result.message,
          submittedAt: result.submittedAt,
          orgId: email.orgId,
          campaignRunId: email.campaignRunId,
          metadata: email.metadata,
        })
        .returning();

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
