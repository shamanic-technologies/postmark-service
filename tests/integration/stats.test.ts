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
});
