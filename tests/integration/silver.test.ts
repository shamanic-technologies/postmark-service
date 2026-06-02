import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { postmarkMessages } from "../../src/db/schema";
import { upsertSilver } from "../../src/lib/silver";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  insertTestOpening,
  insertTestLinkClick,
  insertTestSubscriptionChange,
  randomUUID,
} from "../helpers/test-db";

// Single pool for the whole file — closing it in one describe's afterAll would break the next describe.
afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("upsertSilver — idempotency & implication chain (integration)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("sending insert produces silver row with contacted=true, sent=true (errorCode=0)", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId, toEmail: "alice@test.com" });

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row).toBeDefined();
    expect(row.contacted).toBe(true);
    expect(row.sent).toBe(true);
    expect(row.delivered).toBe(false);
  });

  it("delivery webhook → delivered=true via upsertSilver", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestDelivery(messageId);

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row.delivered).toBe(true);
    expect(row.lastDeliveredAt).not.toBeNull();
  });

  it("bounce overrides delivered → bounced=true, delivered=false", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestDelivery(messageId);
    await insertTestBounce(messageId);

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row.bounced).toBe(true);
    expect(row.delivered).toBe(false);
    expect(row.sent).toBe(true);
  });

  it("click implies opened+delivered+sent", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestLinkClick(messageId);

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row.clicked).toBe(true);
    expect(row.opened).toBe(true);
    expect(row.delivered).toBe(true);
    expect(row.sent).toBe(true);
  });

  it("open does NOT imply clicked", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestOpening(messageId);

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row.opened).toBe(true);
    expect(row.clicked).toBe(false);
  });

  it("subscription change with suppress=true → unsubscribed=true", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestSubscriptionChange(messageId, "alice@test.com", true);

    const [row] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(row.unsubscribed).toBe(true);
  });

  it("upsertSilver is idempotent — running twice yields the same row state", async () => {
    const messageId = randomUUID();
    await insertTestSending({ messageId });
    await insertTestDelivery(messageId);

    const [first] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    await upsertSilver(messageId);
    const [second] = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));

    expect(second.contacted).toBe(first.contacted);
    expect(second.sent).toBe(first.sent);
    expect(second.delivered).toBe(first.delivered);
    expect(second.opened).toBe(first.opened);
    expect(second.clicked).toBe(first.clicked);
    expect(second.bounced).toBe(first.bounced);
  });

  it("upsertSilver is a no-op when no sending row exists (handles webhook-before-send race)", async () => {
    const messageId = randomUUID();
    await upsertSilver(messageId);
    const rows = await db.select().from(postmarkMessages).where(eq(postmarkMessages.messageId, messageId));
    expect(rows.length).toBe(0);
  });
});
