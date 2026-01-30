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

describe("Status Endpoints Integration", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("GET /status/:messageId", () => {
    it("should return 404 for non-existent message", async () => {
      const response = await request(app)
        .get(`/status/${randomUUID()}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Message not found");
    });

    it("should return status 'sent' for message with only sending record", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });

      const response = await request(app)
        .get(`/status/${messageId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.messageId).toBe(messageId);
      expect(response.body.status).toBe("sent");
      expect(response.body.delivery).toBeNull();
      expect(response.body.bounce).toBeNull();
    });

    it("should return status 'delivered' when delivery exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestDelivery(messageId);

      const response = await request(app)
        .get(`/status/${messageId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("delivered");
      expect(response.body.delivery).not.toBeNull();
      expect(response.body.delivery.recipient).toBe("test@example.com");
    });

    it("should return status 'bounced' when bounce exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestBounce(messageId);

      const response = await request(app)
        .get(`/status/${messageId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("bounced");
      expect(response.body.bounce).not.toBeNull();
      expect(response.body.bounce.type).toBe("HardBounce");
    });

    it("should return status 'opened' when opening exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestDelivery(messageId);
      await insertTestOpening(messageId);

      const response = await request(app)
        .get(`/status/${messageId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("opened");
      expect(response.body.openings.length).toBeGreaterThan(0);
    });
  });

  describe("GET /status/by-org/:orgId", () => {
    it("should return empty array for org with no emails", async () => {
      const response = await request(app)
        .get("/status/by-org/non-existent-org")
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(0);
      expect(response.body.emails).toEqual([]);
    });

    it("should return emails for org", async () => {
      const orgId = "test-org-123";
      await insertTestSending({ messageId: randomUUID(), orgId });
      await insertTestSending({ messageId: randomUUID(), orgId });

      const response = await request(app)
        .get(`/status/by-org/${orgId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.orgId).toBe(orgId);
      expect(response.body.count).toBe(2);
      expect(response.body.emails.length).toBe(2);
    });

    it("should respect limit parameter", async () => {
      const orgId = "test-org-limit";
      await insertTestSending({ messageId: randomUUID(), orgId });
      await insertTestSending({ messageId: randomUUID(), orgId });
      await insertTestSending({ messageId: randomUUID(), orgId });

      const response = await request(app)
        .get(`/status/by-org/${orgId}?limit=2`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.emails.length).toBe(2);
    });
  });

  describe("GET /status/by-campaign/:campaignRunId", () => {
    it("should return emails for campaign run", async () => {
      const campaignRunId = "campaign-run-123";
      await insertTestSending({ messageId: randomUUID(), campaignRunId });
      await insertTestSending({ messageId: randomUUID(), campaignRunId });

      const response = await request(app)
        .get(`/status/by-campaign/${campaignRunId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.campaignRunId).toBe(campaignRunId);
      expect(response.body.total).toBe(2);
    });
  });
});
