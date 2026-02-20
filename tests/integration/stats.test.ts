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

describe("POST /stats", () => {
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
      .post("/stats")
      .set(getAuthHeaders())
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("At least one filter");
  });

  it("should filter by runIds (backward compat)", async () => {
    const runId = "run-stats-1";
    await insertTestSending({ messageId: randomUUID(), runId, brandId: "b1", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), runId: "other-run", brandId: "b2", appId: "a2", campaignId: "c2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ runIds: [runId] });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should filter by clerkOrgId", async () => {
    await insertTestSending({ messageId: randomUUID(), orgId: "org-abc", brandId: "b1", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), orgId: "org-other", brandId: "b2", appId: "a2", campaignId: "c2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ clerkOrgId: "org-abc" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should filter by brandId", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-x", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-y", appId: "a2", campaignId: "c2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "brand-x" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should filter by appId", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "app-1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b2", appId: "app-2", campaignId: "c2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ appId: "app-1" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should filter by campaignId", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "camp-1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b2", appId: "a2", campaignId: "camp-2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ campaignId: "camp-1" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should AND multiple filters together", async () => {
    await insertTestSending({ messageId: randomUUID(), orgId: "org-1", brandId: "brand-a", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), orgId: "org-1", brandId: "brand-b", appId: "a2", campaignId: "c2" });
    await insertTestSending({ messageId: randomUUID(), orgId: "org-2", brandId: "brand-a", appId: "a3", campaignId: "c3" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ clerkOrgId: "org-1", brandId: "brand-a" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should include emailsDelivered in response", async () => {
    const msgId = randomUUID();
    await insertTestSending({ messageId: msgId, brandId: "b1", appId: "a1", campaignId: "c1" });
    await insertTestDelivery(msgId);

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "b1" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsDelivered).toBe(1);
  });

  it("should count opens, bounces, and deliveries correctly", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();
    const brand = "brand-full-test";

    await insertTestSending({ messageId: msg1, brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: msg2, brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: msg3, brandId: brand, appId: "a1", campaignId: "c1" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestOpening(msg1);
    await insertTestBounce(msg3);

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: brand });

    expect(response.status).toBe(200);
    const { stats } = response.body;
    expect(stats.emailsSent).toBe(3);
    expect(stats.emailsDelivered).toBe(2);
    expect(stats.emailsOpened).toBe(1);
    expect(stats.emailsBounced).toBe(1);
  });

  it("should return hardcoded 0 for reply metrics", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "c1" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "b1" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsReplied).toBe(0);
    expect(response.body.stats.repliesWillingToMeet).toBe(0);
    expect(response.body.stats.repliesInterested).toBe(0);
    expect(response.body.stats.repliesNotInterested).toBe(0);
    expect(response.body.stats.repliesOutOfOffice).toBe(0);
    expect(response.body.stats.repliesUnsubscribe).toBe(0);
  });

  it("should return all zeros when filter matches no sendings", async () => {
    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "non-existent-brand" });

    expect(response.status).toBe(200);
    const { stats } = response.body;
    expect(stats.emailsSent).toBe(0);
    expect(stats.emailsDelivered).toBe(0);
    expect(stats.emailsOpened).toBe(0);
    expect(stats.emailsClicked).toBe(0);
    expect(stats.emailsBounced).toBe(0);
  });

  it("should include recipients count in flat response", async () => {
    const brand = "brand-recipients";
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "bob@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, appId: "a1", campaignId: "c1" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: brand });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(3);
    expect(response.body.recipients).toBe(2); // alice + bob
  });

  it("should filter by workflowName", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-beta" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-alpha" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "b1", workflowName: "wf-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
  });

  it("should accept workflowName as the sole filter", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-solo" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ workflowName: "wf-solo" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  // ─── groupBy tests ────────────────────────────────────────────────────────

  it("should group by campaignId", async () => {
    const brand = "brand-group-campaign";
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();

    await insertTestSending({ messageId: msg1, brandId: brand, appId: "a1", campaignId: "camp-a" });
    await insertTestSending({ messageId: msg2, brandId: brand, appId: "a1", campaignId: "camp-a" });
    await insertTestSending({ messageId: msg3, brandId: brand, appId: "a1", campaignId: "camp-b" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestOpening(msg1);

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: brand, groupBy: "campaignId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toBeDefined();
    expect(response.body.groups).toHaveLength(2);

    const campA = response.body.groups.find((g: any) => g.key === "camp-a");
    const campB = response.body.groups.find((g: any) => g.key === "camp-b");

    expect(campA).toBeDefined();
    expect(campA.stats.emailsSent).toBe(2);
    expect(campA.stats.emailsDelivered).toBe(2);
    expect(campA.stats.emailsOpened).toBe(1);

    expect(campB).toBeDefined();
    expect(campB.stats.emailsSent).toBe(1);
    expect(campB.stats.emailsDelivered).toBe(0);
  });

  it("should group by brandId", async () => {
    const org = "org-group-brand";
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "brand-x", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "brand-x", appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "brand-y", appId: "a1", campaignId: "c1" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ clerkOrgId: org, groupBy: "brandId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const brandX = response.body.groups.find((g: any) => g.key === "brand-x");
    const brandY = response.body.groups.find((g: any) => g.key === "brand-y");
    expect(brandX.stats.emailsSent).toBe(2);
    expect(brandY.stats.emailsSent).toBe(1);
  });

  it("should group by workflowName", async () => {
    const org = "org-group-wf";
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-1" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-2" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-1" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ clerkOrgId: org, groupBy: "workflowName" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const wf1 = response.body.groups.find((g: any) => g.key === "wf-1");
    const wf2 = response.body.groups.find((g: any) => g.key === "wf-2");
    expect(wf1.stats.emailsSent).toBe(2);
    expect(wf2.stats.emailsSent).toBe(1);
  });

  it("should group by leadEmail", async () => {
    const brand = "brand-group-lead";
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "alice@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "bob@test.com", brandId: brand, appId: "a1", campaignId: "c1" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: brand, groupBy: "leadEmail" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const alice = response.body.groups.find((g: any) => g.key === "alice@test.com");
    const bob = response.body.groups.find((g: any) => g.key === "bob@test.com");
    expect(alice.stats.emailsSent).toBe(2);
    expect(alice.recipients).toBe(1);
    expect(bob.stats.emailsSent).toBe(1);
  });

  it("should include recipients per group", async () => {
    const brand = "brand-group-recip";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: brand, appId: "a1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: brand, appId: "a1", campaignId: "c2" });

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: brand, groupBy: "campaignId" });

    expect(response.status).toBe(200);
    const c1 = response.body.groups.find((g: any) => g.key === "c1");
    const c2 = response.body.groups.find((g: any) => g.key === "c2");
    expect(c1.recipients).toBe(2); // a + b
    expect(c2.recipients).toBe(1); // a
  });

  it("should handle null group keys", async () => {
    const org = "org-null-wf";
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", appId: "a1", campaignId: "c1", workflowName: "wf-1" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", appId: "a1", campaignId: "c1" }); // no workflowName

    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ clerkOrgId: org, groupBy: "workflowName" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const nullGroup = response.body.groups.find((g: any) => g.key === "");
    const wf1 = response.body.groups.find((g: any) => g.key === "wf-1");
    expect(nullGroup.stats.emailsSent).toBe(1);
    expect(wf1.stats.emailsSent).toBe(1);
  });

  it("should reject invalid groupBy value", async () => {
    const response = await request(app)
      .post("/stats")
      .set(getAuthHeaders())
      .send({ brandId: "b1", groupBy: "invalidField" });

    expect(response.status).toBe(400);
  });
});
