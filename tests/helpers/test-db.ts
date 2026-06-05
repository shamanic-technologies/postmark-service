import { db, pool } from "../../src/db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
  postmarkSpamComplaints,
  postmarkSubscriptionChanges,
  postmarkMessages,
} from "../../src/db/schema";
import { sql } from "drizzle-orm";
import { upsertSilver } from "../../src/lib/silver";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  // Delete in order of dependencies (no FKs in this schema, but good practice)
  await db.delete(postmarkMessages);
  await db.delete(postmarkLinkClicks);
  await db.delete(postmarkOpenings);
  await db.delete(postmarkSpamComplaints);
  await db.delete(postmarkSubscriptionChanges);
  await db.delete(postmarkBounces);
  await db.delete(postmarkDeliveries);
  await db.delete(postmarkSendings);
}

/**
 * Insert test sending record
 */
export async function insertTestSending(data: {
  messageId?: string;
  toEmail?: string;
  fromEmail?: string;
  subject?: string;
  orgId?: string;
  runId?: string;
  brandId?: string;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  leadId?: string;
}) {
  const [sending] = await db
    .insert(postmarkSendings)
    .values({
      messageId: data.messageId,
      toEmail: data.toEmail || "test@example.com",
      fromEmail: data.fromEmail || "sender@test.com",
      subject: data.subject || "Test Subject",
      orgId: data.orgId || "test-org-id",
      runId: data.runId || "test-run-id",
      brandIds: data.brandIds ?? (data.brandId ? [data.brandId] : undefined),
      campaignId: data.campaignId,
      workflowSlug: data.workflowSlug,
      featureSlug: data.featureSlug,
      leadId: data.leadId,
      errorCode: 0,
      message: "OK",
      submittedAt: new Date(),
    })
    .returning();

  // Mirror the production write path: silver is materialized on bronze insert.
  if (sending.messageId) await upsertSilver(sending.messageId);

  return sending;
}

/**
 * Insert test delivery record
 */
export async function insertTestDelivery(messageId: string, recipient?: string, deliveredAt?: Date) {
  const [delivery] = await db
    .insert(postmarkDeliveries)
    .values({
      messageId,
      recordType: "Delivery",
      recipient: recipient || "test@example.com",
      deliveredAt: deliveredAt ?? new Date(),
      messageStream: "broadcast",
    })
    .returning();

  await upsertSilver(messageId);
  return delivery;
}

/**
 * Insert test bounce record
 */
export async function insertTestBounce(messageId: string, email?: string, bouncedAt?: Date) {
  const [bounce] = await db
    .insert(postmarkBounces)
    .values({
      id: Math.floor(Math.random() * 1000000000), // Postmark bounce ID is bigint
      messageId,
      recordType: "Bounce",
      type: "HardBounce",
      typeCode: 1,
      email: email || "bounced@example.com",
      bouncedAt: bouncedAt ?? new Date(),
      messageStream: "broadcast",
    })
    .returning();

  await upsertSilver(messageId);
  return bounce;
}

/**
 * Insert test opening record
 */
export async function insertTestOpening(messageId: string, recipient?: string, receivedAt?: Date) {
  const [opening] = await db
    .insert(postmarkOpenings)
    .values({
      messageId,
      recordType: "Open",
      recipient: recipient || "test@example.com",
      receivedAt: receivedAt ?? new Date(),
      firstOpen: true,
      platform: "Desktop",
      messageStream: "broadcast",
    })
    .returning();

  await upsertSilver(messageId);
  return opening;
}

/**
 * Insert test link click record
 */
export async function insertTestLinkClick(messageId: string, recipient?: string, receivedAt?: Date) {
  const [click] = await db
    .insert(postmarkLinkClicks)
    .values({
      messageId,
      recordType: "Click",
      recipient: recipient || "test@example.com",
      receivedAt: receivedAt ?? new Date(),
      platform: "Desktop",
      originalLink: "https://example.com",
      clickLocation: "HTML",
      messageStream: "broadcast",
    })
    .returning();

  await upsertSilver(messageId);
  return click;
}

/**
 * Insert test subscription change record
 */
export async function insertTestSubscriptionChange(
  messageId: string,
  recipient?: string,
  suppressSending?: boolean,
  changedAt?: Date,
) {
  const [change] = await db
    .insert(postmarkSubscriptionChanges)
    .values({
      messageId,
      recordType: "SubscriptionChange",
      recipient: recipient || "test@example.com",
      suppressSending: suppressSending ?? true,
      changedAt: changedAt ?? new Date(),
      messageStream: "broadcast",
    })
    .returning();

  await upsertSilver(messageId);
  return change;
}

/**
 * Close database connection
 */
export async function closeDb() {
  await pool.end();
}

/**
 * Generate a random UUID for testing
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}
