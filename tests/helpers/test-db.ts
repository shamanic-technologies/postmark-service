import { db, pool } from "../../src/db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkOpenings,
  postmarkLinkClicks,
  postmarkSpamComplaints,
  postmarkSubscriptionChanges,
} from "../../src/db/schema";
import { sql } from "drizzle-orm";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  // Delete in order of dependencies (no FKs in this schema, but good practice)
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
      errorCode: 0,
      message: "OK",
      submittedAt: new Date(),
    })
    .returning();
  
  return sending;
}

/**
 * Insert test delivery record
 */
export async function insertTestDelivery(messageId: string, recipient?: string) {
  const [delivery] = await db
    .insert(postmarkDeliveries)
    .values({
      messageId,
      recordType: "Delivery",
      recipient: recipient || "test@example.com",
      deliveredAt: new Date(),
      messageStream: "broadcast",
    })
    .returning();
  
  return delivery;
}

/**
 * Insert test bounce record
 */
export async function insertTestBounce(messageId: string, email?: string) {
  const [bounce] = await db
    .insert(postmarkBounces)
    .values({
      id: Math.floor(Math.random() * 1000000000), // Postmark bounce ID is bigint
      messageId,
      recordType: "Bounce",
      type: "HardBounce",
      typeCode: 1,
      email: email || "bounced@example.com",
      bouncedAt: new Date(),
      messageStream: "broadcast",
    })
    .returning();
  
  return bounce;
}

/**
 * Insert test opening record
 */
export async function insertTestOpening(messageId: string, recipient?: string) {
  const [opening] = await db
    .insert(postmarkOpenings)
    .values({
      messageId,
      recordType: "Open",
      recipient: recipient || "test@example.com",
      receivedAt: new Date(),
      firstOpen: true,
      platform: "Desktop",
      messageStream: "broadcast",
    })
    .returning();
  
  return opening;
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
