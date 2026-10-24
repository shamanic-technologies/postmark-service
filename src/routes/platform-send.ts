import { messageOf } from "../lib/db-error.js";
import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { sendEmailWithToken } from "../lib/postmark-client";
import { getPlatformKey } from "../lib/key-client";
import { PlatformSendRequestSchema } from "../schemas";
import { upsertSilver } from "../lib/silver";
import { openPlatformSendLedger } from "../lib/send-ledger";
import { SEND_SUPPORT } from "../lib/send-support";

const router = Router();

/**
 * POST /internal/platform-send
 *
 * One email with NO organization and NO user, paid by the platform. It exists for
 * mail sent before any organization exists (the self-serve sign-up code, owner
 * 2026-10-12): there is no org to resolve keys against and none to bill, and
 * inventing a placeholder org is banned fleet-wide.
 *
 * - Keys: PLATFORM keys only (key-service `/keys/platform/:provider/decrypt`).
 * - Billing: none. No credit authorization, ever. Authorizing against a brand-new
 *   org would make billing create its account and grant its welcome gift.
 * - Ledger: an org-less platform run with the usual `postmark-email-send` cost.
 * - Record: `postmark_sendings` row with org_id NULL, payer "platform".
 *
 * Org-bearing sends never come through here (`/orgs/send` is untouched).
 * Only `payer: "platform"` is accepted: an org-less send cannot be anything else,
 * so a request that is not explicitly platform-paid is refused, never defaulted.
 */
router.post("/platform-send", async (req: Request, res: Response) => {
  const parsed = PlatformSendRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      code: "INVALID_REQUEST",
      details: parsed.error.flatten(),
    });
  }
  const body = parsed.data;

  if (body.payer !== "platform") {
    return res.status(400).json({
      error: "An org-less send must be platform-paid: send payer: \"platform\"",
      code: "PLATFORM_PAYER_REQUIRED",
    });
  }

  const orgHeader = req.headers["x-org-id"];
  const userHeader = req.headers["x-user-id"];
  if (orgHeader || userHeader) {
    return res.status(400).json({
      error: "POST /internal/platform-send carries no organization or user: drop x-org-id / x-user-id, or use /orgs/send",
      code: "IDENTITY_NOT_ALLOWED",
    });
  }

  const parentRunId = typeof req.headers["x-run-id"] === "string" ? req.headers["x-run-id"] : undefined;
  const caller = { method: "POST" as const, path: "/internal/platform-send" };

  try {
    const serverToken = await getPlatformKey("postmark", caller);
    const messageStream = await getPlatformKey(
      body.stream === "transactional" ? "postmark-transactional-stream" : "postmark-broadcast-stream",
      caller
    );
    const fromAddress = body.from ?? (await getPlatformKey("postmark-from-address", caller));

    // An org-less send names nobody (no subject field on this route): support from creation.
    const ledger = await openPlatformSendLedger({}, SEND_SUPPORT);

    try {
      const result = await sendEmailWithToken({
        serverToken,
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
      });

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
          orgId: null,
          userId: null,
          runId: ledger.runId,
          parentRunId: parentRunId || null,
          payer: "platform",
          metadata: body.metadata,
        })
        .returning();

      if (result.messageId) await upsertSilver(result.messageId);

      if (!result.success || !result.messageId) {
        await ledger.fail(result.message);
        console.error(
          `[platform-send] Postmark rejected — to=${body.to} errorCode=${result.errorCode} message="${result.message}"`
        );
        return res.status(502).json({
          error: "Postmark rejected the message",
          code: "POSTMARK_REJECTED",
          errorCode: result.errorCode,
          message: result.message,
          sendingId: sending.id,
        });
      }

      await ledger.addSendCost("platform");
      await ledger.complete();

      return res.status(200).json({
        success: true,
        messageId: result.messageId,
        submittedAt: result.submittedAt,
        sendingId: sending.id,
        runId: ledger.runId,
      });
    } catch (error: any) {
      await ledger.fail(messageOf(error)).catch(() => {});
      throw error;
    }
  } catch (error: any) {
    console.error(`[platform-send] Failed — to=${body.to} error="${error.message}"`);
    return res.status(500).json({
      error: "Failed to send email",
      code: "SEND_FAILED",
      details: messageOf(error),
    });
  }
});

export default router;
