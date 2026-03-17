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

describe("GET /stats/public", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should work without identity headers", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1" });

    const response = await request(app)
      .get("/stats/public")
      .set(getServiceAuthHeaders())
      .query({});

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsContacted).toBeGreaterThanOrEqual(1);
    expect(response.body.stats.emailsSent).toBeGreaterThanOrEqual(1);
  });

  it("should reject requests without API key", async () => {
    const response = await request(app)
      .get("/stats/public")
      .set({ "Content-Type": "application/json" })
      .query({});

    expect(response.status).toBe(401);
  });

  it("should filter by brandId", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-pub-x", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-pub-y", campaignId: "c2" });

    const response = await request(app)
      .get("/stats/public")
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
      .get("/stats/public")
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
      .get("/stats/public")
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

  it("should reject invalid groupBy", async () => {
    const response = await request(app)
      .get("/stats/public")
      .set(getServiceAuthHeaders())
      .query({ groupBy: "invalidField" });

    expect(response.status).toBe(400);
  });
});
