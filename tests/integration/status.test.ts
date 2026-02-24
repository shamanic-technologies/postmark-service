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
  insertTestSubscriptionChange,
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

  describe("GET /status/by-run/:runId", () => {
    it("should return emails for run", async () => {
      const runId = "run-123";
      await insertTestSending({ messageId: randomUUID(), runId });
      await insertTestSending({ messageId: randomUUID(), runId });

      const response = await request(app)
        .get(`/status/by-run/${runId}`)
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe(runId);
      expect(response.body.total).toBe(2);
    });
  });

  describe("POST /status", () => {
    const brandId = "brand-test";

    it("should return 400 for invalid request", async () => {
      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({});

      expect(response.status).toBe(400);
    });

    it("should return all-false for unknown lead/email", async () => {
      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId: "camp-empty",
          items: [{ leadId: "unknown-lead", email: "nobody@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.leadId).toBe("unknown-lead");
      expect(r.email).toBe("nobody@test.com");
      // campaign scope
      expect(r.campaign.lead.contacted).toBe(false);
      expect(r.campaign.lead.delivered).toBe(false);
      expect(r.campaign.email.contacted).toBe(false);
      expect(r.campaign.email.delivered).toBe(false);
      // brand scope
      expect(r.brand.lead.contacted).toBe(false);
      expect(r.brand.email.contacted).toBe(false);
      // global scope
      expect(r.global.email.bounced).toBe(false);
      expect(r.global.email.unsubscribed).toBe(false);
    });

    it("should return contacted + delivered at campaign and brand scopes", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-status-1";
      await insertTestSending({
        messageId,
        toEmail: "alice@test.com",
        leadId: "lead-alice",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "alice@test.com");

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId,
          items: [{ leadId: "lead-alice", email: "alice@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      // campaign
      expect(r.campaign.lead.contacted).toBe(true);
      expect(r.campaign.lead.delivered).toBe(true);
      expect(r.campaign.lead.lastDeliveredAt).not.toBeNull();
      expect(r.campaign.email.contacted).toBe(true);
      expect(r.campaign.email.delivered).toBe(true);
      // brand
      expect(r.brand.lead.contacted).toBe(true);
      expect(r.brand.lead.delivered).toBe(true);
      expect(r.brand.email.contacted).toBe(true);
      expect(r.brand.email.delivered).toBe(true);
    });

    it("should detect bounces across all scopes", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-bounce";
      await insertTestSending({
        messageId,
        toEmail: "bounced@test.com",
        leadId: "lead-bounce",
        brandId,
        campaignId,
      });
      await insertTestBounce(messageId, "bounced@test.com");

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId,
          items: [{ leadId: "lead-bounce", email: "bounced@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.email.bounced).toBe(true);
      expect(r.brand.email.bounced).toBe(true);
      expect(r.global.email.bounced).toBe(true);
    });

    it("should detect unsubscribes across all scopes", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-unsub";
      await insertTestSending({
        messageId,
        toEmail: "unsub@test.com",
        leadId: "lead-unsub",
        brandId,
        campaignId,
      });
      await insertTestSubscriptionChange(messageId, "unsub@test.com", true);

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId,
          items: [{ leadId: "lead-unsub", email: "unsub@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.email.unsubscribed).toBe(true);
      expect(r.brand.email.unsubscribed).toBe(true);
      expect(r.global.email.unsubscribed).toBe(true);
    });

    it("should separate campaign scope from brand scope", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      // Same brand, different campaigns
      await insertTestSending({
        messageId: msg1,
        toEmail: "shared@test.com",
        leadId: "lead-shared",
        brandId,
        campaignId: "camp-A",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "shared@test.com",
        leadId: "lead-shared",
        brandId,
        campaignId: "camp-B",
      });
      await insertTestDelivery(msg1, "shared@test.com");

      // Query for camp-B: campaign should NOT show delivered, brand SHOULD
      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId: "camp-B",
          items: [{ leadId: "lead-shared", email: "shared@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.email.contacted).toBe(true);
      expect(r.campaign.email.delivered).toBe(false);
      expect(r.brand.email.contacted).toBe(true);
      expect(r.brand.email.delivered).toBe(true);
    });

    it("should aggregate lead across multiple emails", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        toEmail: "email1@test.com",
        leadId: "lead-multi",
        brandId,
        campaignId: "camp-multi",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "email2@test.com",
        leadId: "lead-multi",
        brandId,
        campaignId: "camp-multi",
      });
      await insertTestDelivery(msg2, "email2@test.com");

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId: "camp-multi",
          items: [{ leadId: "lead-multi", email: "email1@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      // Lead aggregation: contacted via msg1+msg2, delivered via msg2
      expect(r.campaign.lead.contacted).toBe(true);
      expect(r.campaign.lead.delivered).toBe(true);
      // Email-specific: email1 was not delivered
      expect(r.campaign.email.contacted).toBe(true);
      expect(r.campaign.email.delivered).toBe(false);
    });

    it("should handle multiple items in a single request", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      const campaignId = "camp-batch";

      await insertTestSending({
        messageId: msg1,
        toEmail: "a@test.com",
        leadId: "lead-a",
        brandId,
        campaignId,
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "b@test.com",
        leadId: "lead-b",
        brandId,
        campaignId,
      });
      await insertTestDelivery(msg1, "a@test.com");

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId,
          items: [
            { leadId: "lead-a", email: "a@test.com" },
            { leadId: "lead-b", email: "b@test.com" },
            { leadId: "lead-c", email: "c@test.com" },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(3);

      const aResult = response.body.results.find((r: any) => r.email === "a@test.com");
      const bResult = response.body.results.find((r: any) => r.email === "b@test.com");
      const cResult = response.body.results.find((r: any) => r.email === "c@test.com");

      expect(aResult.campaign.email.contacted).toBe(true);
      expect(aResult.campaign.email.delivered).toBe(true);
      expect(bResult.campaign.email.contacted).toBe(true);
      expect(bResult.campaign.email.delivered).toBe(false);
      expect(cResult.campaign.email.contacted).toBe(false);
      expect(cResult.campaign.email.delivered).toBe(false);
    });

    it("should return campaign=null when no campaignId provided", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "nocampaign@test.com",
        leadId: "lead-nocamp",
        brandId,
      });

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          items: [{ leadId: "lead-nocamp", email: "nocampaign@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign).toBeNull();
      expect(r.brand.lead.contacted).toBe(true);
    });

    it("should always return replied=false", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-reply";
      await insertTestSending({
        messageId,
        toEmail: "reply@test.com",
        leadId: "lead-reply",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "reply@test.com");

      const response = await request(app)
        .post("/status")
        .set(getAuthHeaders())
        .send({
          brandId,
          campaignId,
          items: [{ leadId: "lead-reply", email: "reply@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.lead.replied).toBe(false);
      expect(r.brand.lead.replied).toBe(false);
    });
  });
});
