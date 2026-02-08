import { Router, Request, Response } from "express";
import { db } from "../db";
import {
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
  postmarkSpamComplaints,
  postmarkSubscriptionChanges,
} from "../db/schema";

const router = Router();

/**
 * POST /webhooks/postmark
 * Handle all Postmark webhook events
 *
 * Postmark sends different event types:
 * - Delivery
 * - Bounce
 * - Open
 * - Click
 * - SpamComplaint
 * - SubscriptionChange
 */
router.post("/webhooks/postmark", async (req: Request, res: Response) => {
  const payload = req.body;

  // Verify webhook secret via custom header (configured in Postmark webhook settings)
  const webhookSecret = process.env.POSTMARK_WEBHOOK_SECRET;
  if (webhookSecret) {
    const providedSecret = req.headers["x-postmark-webhook-secret"];
    if (providedSecret !== webhookSecret) {
      console.error("Invalid or missing webhook secret");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const recordType = payload.RecordType;

  if (!recordType) {
    console.error("Missing RecordType in webhook payload");
    return res.status(400).json({ error: "Missing RecordType" });
  }

  try {
    switch (recordType) {
      case "Delivery":
        await handleDelivery(payload);
        break;
      case "Bounce":
        await handleBounce(payload);
        break;
      case "Open":
        await handleOpen(payload);
        break;
      case "Click":
        await handleClick(payload);
        break;
      case "SpamComplaint":
        await handleSpamComplaint(payload);
        break;
      case "SubscriptionChange":
        await handleSubscriptionChange(payload);
        break;
      default:
        console.warn(`Unknown RecordType: ${recordType}`);
    }

    res.status(200).json({ success: true, recordType });
  } catch (error: any) {
    console.error(`Error handling ${recordType} webhook:`, error);
    res.status(500).json({
      error: "Failed to process webhook",
      details: error.message,
    });
  }
});

async function handleDelivery(payload: any) {
  await db.insert(postmarkDeliveries).values({
    messageId: payload.MessageID,
    recordType: payload.RecordType,
    serverId: payload.ServerID,
    messageStream: payload.MessageStream,
    recipient: payload.Recipient,
    tag: payload.Tag,
    deliveredAt: payload.DeliveredAt ? new Date(payload.DeliveredAt) : null,
    details: payload.Details,
    metadata: payload.Metadata,
    headers: payload.Headers,
  }).onConflictDoNothing();

  console.log(`Delivery recorded for ${payload.Recipient}`);
}

async function handleBounce(payload: any) {
  await db.insert(postmarkBounces).values({
    id: payload.ID,
    recordType: payload.RecordType,
    type: payload.Type,
    typeCode: payload.TypeCode,
    name: payload.Name,
    tag: payload.Tag,
    messageId: payload.MessageID,
    serverId: payload.ServerID,
    description: payload.Description,
    details: payload.Details,
    email: payload.Email,
    fromAddress: payload.From,
    bouncedAt: payload.BouncedAt ? new Date(payload.BouncedAt) : null,
    dumpAvailable: payload.DumpAvailable,
    inactive: payload.Inactive,
    canActivate: payload.CanActivate,
    subject: payload.Subject,
    content: payload.Content,
    messageStream: payload.MessageStream,
    metadata: payload.Metadata,
  }).onConflictDoNothing();

  console.log(`Bounce (${payload.Type}) recorded for ${payload.Email}`);
}

async function handleOpen(payload: any) {
  await db.insert(postmarkOpenings).values({
    recordType: payload.RecordType,
    messageStream: payload.MessageStream,
    metadata: payload.Metadata,
    firstOpen: payload.FirstOpen,
    recipient: payload.Recipient,
    messageId: payload.MessageID,
    receivedAt: payload.ReceivedAt ? new Date(payload.ReceivedAt) : null,
    platform: payload.Platform,
    readSeconds: payload.ReadSeconds,
    tag: payload.Tag,
    userAgent: payload.UserAgent,
    os: payload.OS,
    client: payload.Client,
    geo: payload.Geo,
  });

  console.log(`Open recorded for ${payload.Recipient}`);
}

async function handleClick(payload: any) {
  await db.insert(postmarkLinkClicks).values({
    recordType: payload.RecordType,
    messageStream: payload.MessageStream,
    metadata: payload.Metadata,
    recipient: payload.Recipient,
    messageId: payload.MessageID,
    receivedAt: payload.ReceivedAt ? new Date(payload.ReceivedAt) : null,
    platform: payload.Platform,
    clickLocation: payload.ClickLocation,
    originalLink: payload.OriginalLink,
    tag: payload.Tag,
    userAgent: payload.UserAgent,
    os: payload.OS,
    client: payload.Client,
    geo: payload.Geo,
  });

  console.log(`Click recorded for ${payload.Recipient}: ${payload.OriginalLink}`);
}

async function handleSpamComplaint(payload: any) {
  await db.insert(postmarkSpamComplaints).values({
    recordType: payload.RecordType,
    messageStream: payload.MessageStream,
    metadata: payload.Metadata,
    messageId: payload.MessageID,
    serverId: payload.ServerID,
    tag: payload.Tag,
    email: payload.Email,
    fromAddress: payload.From,
    bouncedAt: payload.BouncedAt ? new Date(payload.BouncedAt) : null,
    subject: payload.Subject,
  }).onConflictDoNothing();

  console.log(`Spam complaint recorded for ${payload.Email}`);
}

async function handleSubscriptionChange(payload: any) {
  await db.insert(postmarkSubscriptionChanges).values({
    recordType: payload.RecordType,
    messageStream: payload.MessageStream,
    metadata: payload.Metadata,
    messageId: payload.MessageID,
    serverId: payload.ServerID,
    tag: payload.Tag,
    recipient: payload.Recipient,
    origin: payload.Origin,
    suppressSending: payload.SuppressSending,
    changedAt: payload.ChangedAt ? new Date(payload.ChangedAt) : null,
  }).onConflictDoNothing();

  console.log(`Subscription change recorded for ${payload.Recipient}`);
}

export default router;
