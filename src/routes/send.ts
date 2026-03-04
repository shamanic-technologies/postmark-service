import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { sendEmail, SendEmailParams } from "../lib/postmark-client";
import { getOrgKey, getStreamId } from "../lib/key-client";
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
 * BLOCKING: runs-service must succeed before email is sent
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
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parentRunId = req.headers["x-run-id"] as string;

  try {
    // 1. Resolve key from key-service (get keySource for cost tracking)
    const caller = { method: "POST" as const, path: "/send" };
    const decryptedKey = await getOrgKey(orgId, userId, "postmark", caller);

    // 2. Resolve message stream from key-service
    const messageStream = await getStreamId(orgId, userId, "broadcast", caller);

    // 3. Create run in runs-service (BLOCKING)
    const sendRun = await createRun({
      orgId,
      serviceName: "postmark-service",
      taskName: "email-send",
      parentRunId,
      userId,
      brandId: body.brandId,
      campaignId: body.campaignId,
      workflowName: body.workflowName,
    });
    const sendRunId = sendRun.id;

    try {
      // 4. Send email via Postmark
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

      // 5. Record in database
      const [sending] = await db
        .insert(postmarkSendings)
        .values({
          messageId: result.messageId,
          toEmail: body.to,
          fromEmail: body.from,
          subject: body.subject,
          tag: body.tag,
          messageStream,
          errorCode: result.errorCode,
          message: result.message,
          submittedAt: result.submittedAt,
          orgId,
          userId,
          runId: sendRunId,
          brandId: body.brandId,
          campaignId: body.campaignId,
          workflowName: body.workflowName,
          leadId: body.leadId,
          metadata: body.metadata,
        })
        .returning();

      // 6. Log costs and complete run
      if (result.success) {
        await addCosts(sendRunId, [
          { costName: "postmark-email-send", quantity: 1, costSource: decryptedKey.keySource },
        ], orgId, userId);
        await updateRun(sendRunId, "completed", orgId, userId);

        res.status(200).json({
          success: true,
          messageId: result.messageId,
          submittedAt: result.submittedAt,
          sendingId: sending.id,
        });
      } else {
        await updateRun(sendRunId, "failed", orgId, userId, result.message);

        res.status(400).json({
          success: false,
          errorCode: result.errorCode,
          message: result.message,
          sendingId: sending.id,
        });
      }
    } catch (error: any) {
      // Email send or DB failed — mark run as failed
      await updateRun(sendRunId, "failed", orgId, userId, error.message);
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
  const results = [];

  // Resolve key and stream once for the batch (same org for all emails)
  let keySource: "platform" | "org";
  let messageStream: string;
  try {
    const batchCaller = { method: "POST" as const, path: "/send/batch" };
    const decryptedKey = await getOrgKey(orgId, userId, "postmark", batchCaller);
    keySource = decryptedKey.keySource;
    messageStream = await getStreamId(orgId, userId, "broadcast", batchCaller);
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
      // 1. Create run in runs-service (BLOCKING)
      const sendRun = await createRun({
        orgId,
        serviceName: "postmark-service",
        taskName: "email-send",
        parentRunId,
        userId,
        brandId: email.brandId,
        campaignId: email.campaignId,
        workflowName: email.workflowName,
      });
      const sendRunId = sendRun.id;

      try {
        // 2. Send email via Postmark
        const batchCaller = { method: "POST" as const, path: "/send/batch" };
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
            fromEmail: email.from,
            subject: email.subject,
            tag: email.tag,
            messageStream,
            errorCode: result.errorCode,
            message: result.message,
            submittedAt: result.submittedAt,
            orgId,
            userId,
            runId: sendRunId,
            brandId: email.brandId,
            campaignId: email.campaignId,
            workflowName: email.workflowName,
            leadId: email.leadId,
            metadata: email.metadata,
          })
          .returning();

        // 4. Log costs and complete run
        if (result.success) {
          await addCosts(sendRunId, [
            { costName: "postmark-email-send", quantity: 1, costSource: keySource },
          ], orgId, userId);
          await updateRun(sendRunId, "completed", orgId, userId);
        } else {
          await updateRun(sendRunId, "failed", orgId, userId, result.message);
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
        await updateRun(sendRunId, "failed", orgId, userId, error.message);
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
