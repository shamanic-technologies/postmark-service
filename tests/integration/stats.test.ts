import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  insertTestOpening,
  randomUUID,
} from "../helpers/test-db";

describe("GET /stats", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should return 400 when no filters provided", async () => {
    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least one filter/i);
  });

  it("should return 400 when only groupBy is provided (no filter)", async () => {
    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ groupBy: "workflowSlug" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least one filter/i);
  });

  it("should return grouped stats when groupBy and a filter are provided", async () => {
    const orgId = "org-grouped-" + randomUUID();
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "wf-global-a", orgId });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "wf-global-b", orgId });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ groupBy: "workflowSlug", orgId });

    expect(response.status).toBe(200);
    expect(response.body.groups).toBeDefined();
    const wfA = response.body.groups.find((g: any) => g.key === "wf-global-a");
    const wfB = response.body.groups.find((g: any) => g.key === "wf-global-b");
    expect(wfA).toBeDefined();
    expect(wfB).toBeDefined();
  });

  it("should filter by runIds (comma-separated)", async () => {
    const runId = "run-stats-1";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", runId, brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", runId: "other-run", brandId: "b2", campaignId: "c2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ runIds: runId });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  it("should filter by multiple runIds (comma-separated)", async () => {
    const runId1 = "run-multi-1";
    const runId2 = "run-multi-2";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", runId: runId1, brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", runId: runId2, brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", runId: "other-run", brandId: "b2", campaignId: "c2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ runIds: `${runId1},${runId2}` });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
  });

  it("should filter by orgId", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: "org-abc", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: "org-other", brandId: "b2", campaignId: "c2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: "org-abc" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  it("should filter by brandId", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "brand-x", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "brand-y", campaignId: "c2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "brand-x" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  it("should filter by campaignId", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "camp-1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b2", campaignId: "camp-2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ campaignId: "camp-1" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  it("should AND multiple filters together", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: "org-1", brandId: "brand-a", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: "org-1", brandId: "brand-b", campaignId: "c2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: "org-2", brandId: "brand-a", campaignId: "c3" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: "org-1", brandId: "brand-a" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  it("should include delivered in response", async () => {
    const msgId = randomUUID();
    await insertTestSending({ messageId: msgId, brandId: "b1", campaignId: "c1" });
    await insertTestDelivery(msgId);

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "b1" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.delivered).toBe(1);
    expect(response.body.emailStats.delivered).toBe(1);
  });

  it("should count opens, bounces, and deliveries correctly by unique recipient", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();
    const brand = "brand-full-test";

    // 3 different recipients
    await insertTestSending({ messageId: msg1, toEmail: "a@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: msg2, toEmail: "b@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: msg3, toEmail: "c@test.com", brandId: brand, campaignId: "c1" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestOpening(msg1);
    await insertTestBounce(msg3);

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: brand });

    expect(response.status).toBe(200);
    const { recipientStats, emailStats } = response.body;
    expect(recipientStats.contacted).toBe(3);
    expect(recipientStats.sent).toBe(3);
    expect(recipientStats.delivered).toBe(2);
    expect(recipientStats.opened).toBe(1);
    expect(recipientStats.bounced).toBe(1);
    // emailStats counts per message, not per recipient
    expect(emailStats.sent).toBe(3);
    expect(emailStats.delivered).toBe(2);
    expect(emailStats.opened).toBe(1);
    expect(emailStats.bounced).toBe(1);
  });

  it("should return hardcoded 0 for reply metrics", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "b1" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.repliesPositive).toBe(0);
    expect(response.body.recipientStats.repliesNegative).toBe(0);
    expect(response.body.recipientStats.repliesNeutral).toBe(0);
    expect(response.body.recipientStats.repliesAutoReply).toBe(0);
    expect(response.body.recipientStats.repliesDetail).toEqual({
      interested: 0,
      meetingBooked: 0,
      closed: 0,
      notInterested: 0,
      wrongPerson: 0,
      unsubscribe: 0,
      neutral: 0,
      autoReply: 0,
      outOfOffice: 0,
    });
  });

  it("should return all zeros when filter matches no sendings", async () => {
    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "non-existent-brand" });

    expect(response.status).toBe(200);
    const { recipientStats, emailStats } = response.body;
    expect(recipientStats.contacted).toBe(0);
    expect(recipientStats.sent).toBe(0);
    expect(recipientStats.delivered).toBe(0);
    expect(recipientStats.opened).toBe(0);
    expect(recipientStats.clicked).toBe(0);
    expect(recipientStats.bounced).toBe(0);
    expect(emailStats.sent).toBe(0);
    expect(emailStats.stepStats).toEqual([]);
  });

  it("should count by unique recipient in recipientStats (not by message count)", async () => {
    const brand = "brand-recipients";
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "bob@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, campaignId: "c1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: brand });

    expect(response.status).toBe(200);
    // recipientStats: 3 messages but only 2 unique recipients
    expect(response.body.recipientStats.contacted).toBe(2);
    expect(response.body.recipientStats.sent).toBe(2);
    // emailStats: counts per message
    expect(response.body.emailStats.sent).toBe(3);
  });

  it("should filter by workflowSlugs", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-beta" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-alpha" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "b1", workflowSlugs: "wf-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
  });

  it("should accept workflowSlugs as the sole filter", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-solo" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ workflowSlugs: "wf-solo" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(1);
  });

  // ─── groupBy tests ────────────────────────────────────────────────────────

  it("should group by campaignId", async () => {
    const brand = "brand-group-campaign";
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();

    await insertTestSending({ messageId: msg1, toEmail: "a@test.com", brandId: brand, campaignId: "camp-a" });
    await insertTestSending({ messageId: msg2, toEmail: "b@test.com", brandId: brand, campaignId: "camp-a" });
    await insertTestSending({ messageId: msg3, toEmail: "c@test.com", brandId: brand, campaignId: "camp-b" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestOpening(msg1);

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: brand, groupBy: "campaignId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toBeDefined();
    expect(response.body.groups).toHaveLength(2);

    const campA = response.body.groups.find((g: any) => g.key === "camp-a");
    const campB = response.body.groups.find((g: any) => g.key === "camp-b");

    expect(campA).toBeDefined();
    expect(campA.recipientStats.sent).toBe(2);
    expect(campA.recipientStats.delivered).toBe(2);
    expect(campA.recipientStats.opened).toBe(1);

    expect(campB).toBeDefined();
    expect(campB.recipientStats.sent).toBe(1);
    expect(campB.recipientStats.delivered).toBe(0);
  });

  it("should group by brandId", async () => {
    const org = "org-group-brand";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "brand-x", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "brand-x", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: org, brandId: "brand-y", campaignId: "c1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "brandId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const brandX = response.body.groups.find((g: any) => g.key === "brand-x");
    const brandY = response.body.groups.find((g: any) => g.key === "brand-y");
    expect(brandX.recipientStats.sent).toBe(2);
    expect(brandY.recipientStats.sent).toBe(1);
  });

  it("should group by workflowSlug", async () => {
    const org = "org-group-wf";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "wf-1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "wf-2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "wf-1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "workflowSlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const wf1 = response.body.groups.find((g: any) => g.key === "wf-1");
    const wf2 = response.body.groups.find((g: any) => g.key === "wf-2");
    expect(wf1.recipientStats.sent).toBe(2);
    expect(wf2.recipientStats.sent).toBe(1);
  });

  it("should group by recipientEmail", async () => {
    const brand = "brand-group-lead";
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "bob@test.com", brandId: brand, campaignId: "c1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: brand, groupBy: "recipientEmail" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const alice = response.body.groups.find((g: any) => g.key === "alice@test.com");
    const bob = response.body.groups.find((g: any) => g.key === "bob@test.com");
    // recipientStats: grouped by recipient so each group has 1 unique recipient
    expect(alice.recipientStats.sent).toBe(1);
    // emailStats: alice has 2 messages
    expect(alice.emailStats.sent).toBe(2);
    expect(bob.recipientStats.sent).toBe(1);
  });

  it("should include recipientStats per group", async () => {
    const brand = "brand-group-recip";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: brand, campaignId: "c2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: brand, groupBy: "campaignId" });

    expect(response.status).toBe(200);
    const c1 = response.body.groups.find((g: any) => g.key === "c1");
    const c2 = response.body.groups.find((g: any) => g.key === "c2");
    expect(c1.recipientStats.sent).toBe(2); // a + b
    expect(c2.recipientStats.sent).toBe(1); // a
  });

  it("should handle null group keys", async () => {
    const org = "org-null-wf";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "wf-1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1" }); // no workflowSlug

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "workflowSlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const nullGroup = response.body.groups.find((g: any) => g.key === "");
    const wf1 = response.body.groups.find((g: any) => g.key === "wf-1");
    expect(nullGroup.recipientStats.sent).toBe(1);
    expect(wf1.recipientStats.sent).toBe(1);
  });

  it("should reject invalid groupBy value", async () => {
    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ brandId: "b1", groupBy: "invalidField" });

    expect(response.status).toBe(400);
  });
});
