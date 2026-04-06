import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  insertTestOpening,
  randomUUID,
} from "../helpers/test-db";

/**
 * Helper: service-auth-only headers (no x-org-id, x-user-id, x-run-id)
 */
function getServiceAuthHeaders() {
  return {
    "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
    "Content-Type": "application/json",
  };
}

describe("GET /internal/stats", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should work without identity headers when a filter is provided", async () => {
    const brandId = "b-public-" + randomUUID().slice(0, 8);
    await insertTestSending({ messageId: randomUUID(), brandId, campaignId: "c1" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ brandId });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsContacted).toBeGreaterThanOrEqual(1);
    expect(response.body.stats.emailsSent).toBeGreaterThanOrEqual(1);
  });

  it("should return 400 without any filters", async () => {
    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least one filter/i);
  });

  it("should reject requests without API key", async () => {
    const response = await request(app)
      .get("/internal/stats")
      .set({ "Content-Type": "application/json" })
      .query({});

    expect(response.status).toBe(401);
  });

  it("should filter by brandId", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-pub-x", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-pub-y", campaignId: "c2" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ brandId: "brand-pub-x" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should support groupBy", async () => {
    const brand = "brand-pub-group";
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "camp-a" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "camp-b" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ brandId: brand, groupBy: "campaignId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);
  });

  it("should count delivery events correctly", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const brand = "brand-pub-events";

    await insertTestSending({ messageId: msg1, brandId: brand, campaignId: "c1" });
    await insertTestSending({ messageId: msg2, brandId: brand, campaignId: "c1" });

    await insertTestDelivery(msg1);
    await insertTestOpening(msg1);
    await insertTestBounce(msg2);

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ brandId: brand });

    expect(response.status).toBe(200);
    const { stats } = response.body;
    expect(stats.emailsContacted).toBe(2);
    expect(stats.emailsSent).toBe(2);
    expect(stats.emailsDelivered).toBe(1);
    expect(stats.emailsOpened).toBe(1);
    expect(stats.emailsBounced).toBe(1);
  });

  it("should filter by featureSlugs (comma-separated plural)", async () => {
    const brand = "brand-pub-fslugs";
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "sales-cold-email-outreach" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "marketing-newsletter" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "other-feature" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ featureSlugs: "sales-cold-email-outreach,marketing-newsletter" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
  });

  it("should filter by workflowSlugs (comma-separated plural)", async () => {
    const brand = "brand-pub-wslugs";
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", workflowSlug: "wf-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", workflowSlug: "wf-beta" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", workflowSlug: "wf-gamma" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ workflowSlugs: "wf-alpha,wf-beta" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
  });

  it("should support groupBy workflowSlug with featureSlugs filter", async () => {
    const brand = "brand-pub-grp-fslugs";
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "sales-cold-email-outreach", workflowSlug: "wf-1" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "sales-cold-email-outreach", workflowSlug: "wf-2" });
    await insertTestSending({ messageId: randomUUID(), brandId: brand, campaignId: "c1", featureSlug: "other-feature", workflowSlug: "wf-3" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ featureSlugs: "sales-cold-email-outreach", groupBy: "workflowSlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);
    const keys = response.body.groups.map((g: any) => g.key).sort();
    expect(keys).toEqual(["wf-1", "wf-2"]);
  });

  it("should filter by single featureSlugs value (no comma)", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b-single", campaignId: "c1", featureSlug: "sales-cold-email-outreach" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b-single", campaignId: "c1", featureSlug: "other" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ featureSlugs: "sales-cold-email-outreach" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(1);
  });

  it("should reject invalid groupBy", async () => {
    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceAuthHeaders())
      .query({ groupBy: "invalidField" });

    expect(response.status).toBe(400);
  });
});
