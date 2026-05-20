import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { postmarkMessages, postmarkStatsDaily } from "../../src/db/schema";
import { upsertSilver } from "../../src/lib/silver";
import { refreshStatsDaily } from "../../src/lib/gold";
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

describe("refreshStatsDaily — gold rollup (integration)", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  it("builds total + workflow_slug + brand_id rollups from silver", async () => {
    const featureSlug = "sales-cold-email-outreach";
    const wf = "cold-email-v1";
    const brand = "brand-a";

    await insertTestSending({
      messageId: randomUUID(),
      toEmail: "x@test.com",
      featureSlug,
      workflowSlug: wf,
      brandIds: [brand],
    });
    await insertTestSending({
      messageId: randomUUID(),
      toEmail: "y@test.com",
      featureSlug,
      workflowSlug: wf,
      brandIds: [brand],
    });

    await refreshStatsDaily({ windowDays: 30 });

    const totals = await db
      .select()
      .from(postmarkStatsDaily)
      .where(eq(postmarkStatsDaily.featureSlug, featureSlug));

    const totalRow = totals.find((r) => r.groupDim === "total");
    const wfRow = totals.find((r) => r.groupDim === "workflow_slug" && r.groupKey === wf);
    const brandRow = totals.find((r) => r.groupDim === "brand_id" && r.groupKey === brand);

    expect(totalRow?.sent).toBe(2);
    expect(totalRow?.recipients).toBe(2);
    expect(wfRow?.sent).toBe(2);
    expect(brandRow?.sent).toBe(2);
  });

  it("rerunning refreshStatsDaily is idempotent — no duplicate rows", async () => {
    const featureSlug = "hiring-cold-email-outreach";
    await insertTestSending({
      messageId: randomUUID(),
      toEmail: "a@test.com",
      featureSlug,
      workflowSlug: "wf",
    });

    await refreshStatsDaily({ windowDays: 30 });
    const first = await db.select().from(postmarkStatsDaily);
    await refreshStatsDaily({ windowDays: 30 });
    const second = await db.select().from(postmarkStatsDaily);

    expect(second.length).toBe(first.length);
  });
});
