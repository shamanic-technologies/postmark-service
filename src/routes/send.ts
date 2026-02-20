import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";
import {
  createRun,
  updateRun,
  addCosts,
} from "../lib/runs-client";
import { SendEmailRequestSchema, BatchSendRequestSchema } from "../schemas";

const router = Router();

/**
 * POST /send
 * Send an email via Postmark and record it in the database
 * BLOCKING: runs-service must succeed before email is sent (when orgId provided)
 */
router.post("/send", async (req: Request, res: Response) => {
  const parsed = SendEmailRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const body = parsed.data;

  try {
    // 1. Create run in runs-service if orgId provided (BLOCKING)
    let sendRunId: string | undefined;
    if (body.orgId) {
      const sendRun = await createRun({
        clerkOrgId: body.orgId,
        appId: body.appId || "mcpfactory",
        serviceName: "postmark-service",
        taskName: "email-send",
        parentRunId: body.runId,
        brandId: body.brandId,
        campaignId: body.campaignId,
        workflowName: body.workflowName,
      });
      sendRunId = sendRun.id;
    }

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
        appId: body.appId,
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
          runId: sendRunId,
          brandId: body.brandId,
          appId: body.appId,
          campaignId: body.campaignId,
          workflowName: body.workflowName,
          metadata: body.metadata,
        })
        .returning();

      // 4. Log costs and complete run
      if (result.success) {
        if (sendRunId) {
          await addCosts(sendRunId, [
            { costName: "postmark-email-send", quantity: 1 },
          ]);
          await updateRun(sendRunId, "completed");
        }

        res.status(200).json({
          success: true,
          messageId: result.messageId,
          submittedAt: result.submittedAt,
          sendingId: sending.id,
        });
      } else {
        if (sendRunId) {
          await updateRun(sendRunId, "failed", result.message);
        }

        res.status(400).json({
          success: false,
          errorCode: result.errorCode,
          message: result.message,
          sendingId: sending.id,
        });
      }
    } catch (error: any) {
      // Email send or DB failed — mark run as failed
      if (sendRunId) {
        await updateRun(sendRunId, "failed", error.message);
      }
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
 * BLOCKING: runs-service must succeed before each email is sent (when orgId provided)
 */
router.post("/send/batch", async (req: Request, res: Response) => {
  const parsed = BatchSendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const { emails } = parsed.data;
  const results = [];

  for (const email of emails) {
    try {
      // 1. Create run in runs-service if orgId provided (BLOCKING)
      let sendRunId: string | undefined;
      if (email.orgId) {
        const sendRun = await createRun({
          clerkOrgId: email.orgId,
          appId: email.appId || "mcpfactory",
          serviceName: "postmark-service",
          taskName: "email-send",
          parentRunId: email.runId,
          brandId: email.brandId,
          campaignId: email.campaignId,
          workflowName: email.workflowName,
        });
        sendRunId = sendRun.id;
      }

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
          appId: email.appId,
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
            runId: sendRunId,
            brandId: email.brandId,
            appId: email.appId,
            campaignId: email.campaignId,
            workflowName: email.workflowName,
            metadata: email.metadata,
          })
          .returning();

        // 4. Log costs and complete run
        if (result.success) {
          if (sendRunId) {
            await addCosts(sendRunId, [
              { costName: "postmark-email-send", quantity: 1 },
            ]);
            await updateRun(sendRunId, "completed");
          }
        } else {
          if (sendRunId) {
            await updateRun(sendRunId, "failed", result.message);
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
        // Email send or DB failed — mark run as failed
        if (sendRunId) {
          await updateRun(sendRunId, "failed", error.message);
        }
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
