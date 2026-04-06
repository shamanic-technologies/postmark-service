import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getServiceHeaders } from "../helpers/test-app";
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

  describe("GET /internal/status/:messageId", () => {
    it("should return 404 for non-existent message", async () => {
      const response = await request(app)
        .get(`/internal/status/${randomUUID()}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Message not found");
    });

    it("should return status 'sent' for message with only sending record", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

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
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

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
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

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
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("opened");
      expect(response.body.openings.length).toBeGreaterThan(0);
    });
  });

  describe("GET /internal/status/by-org/:orgId", () => {
    it("should return empty array for org with no emails", async () => {
      const response = await request(app)
        .get("/internal/status/by-org/non-existent-org")
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(0);
      expect(response.body.emails).toEqual([]);
    });

    it("should return emails for org", async () => {
      const orgId = "test-org-123";
      await insertTestSending({ messageId: randomUUID(), orgId });
      await insertTestSending({ messageId: randomUUID(), orgId });

      const response = await request(app)
        .get(`/internal/status/by-org/${orgId}`)
        .set(getServiceHeaders());

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
        .get(`/internal/status/by-org/${orgId}?limit=2`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.emails.length).toBe(2);
    });
  });

  describe("GET /internal/status/by-run/:runId", () => {
    it("should return emails for run", async () => {
      const runId = "run-123";
      await insertTestSending({ messageId: randomUUID(), runId });
      await insertTestSending({ messageId: randomUUID(), runId });

      const response = await request(app)
        .get(`/internal/status/by-run/${runId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe(runId);
      expect(response.body.total).toBe(2);
    });
  });

  describe("POST /orgs/status", () => {
    const brandId = "brand-test";

    function statusHeaders() {
      return { ...getAuthHeaders(), "x-brand-id": brandId };
    }

    it("should return brand=null when x-brand-id header is missing", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "nobrand@test.com",
        leadId: "lead-nobrand",
        brandId: "some-brand",
        campaignId: "camp-nobrand",
      });

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId: "camp-nobrand",
          items: [{ email: "nobrand@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.brand).toBeNull();
      expect(r.campaign).not.toBeNull();
      expect(r.global).not.toBeNull();
    });

    it("should return 400 for invalid request body", async () => {
      const response = await request(app)
        .post("/orgs/status")
        .set(statusHeaders())
        .send({});

      expect(response.status).toBe(400);
    });

    it("should return all-false for unknown email", async () => {
      const response = await request(app)
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId: "camp-empty",
          items: [{ email: "nobody@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.email).toBe("nobody@test.com");
      expect(r.leadId).toBeNull();
      // campaign scope (flat)
      expect(r.campaign.contacted).toBe(false);
      expect(r.campaign.delivered).toBe(false);
      expect(r.campaign.opened).toBe(false);
      expect(r.campaign.replied).toBe(false);
      expect(r.campaign.replyClassification).toBeNull();
      expect(r.campaign.bounced).toBe(false);
      expect(r.campaign.unsubscribed).toBe(false);
      // brand scope (flat)
      expect(r.brand.contacted).toBe(false);
      expect(r.brand.bounced).toBe(false);
      // global scope (flat)
      expect(r.global.bounced).toBe(false);
      expect(r.global.unsubscribed).toBe(false);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "alice@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.leadId).toBe("lead-alice");
      // campaign (flat)
      expect(r.campaign.contacted).toBe(true);
      expect(r.campaign.delivered).toBe(true);
      expect(r.campaign.lastDeliveredAt).not.toBeNull();
      // brand (flat)
      expect(r.brand.contacted).toBe(true);
      expect(r.brand.delivered).toBe(true);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "bounced@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.bounced).toBe(true);
      expect(r.brand.bounced).toBe(true);
      expect(r.global.bounced).toBe(true);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "unsub@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.unsubscribed).toBe(true);
      expect(r.brand.unsubscribed).toBe(true);
      expect(r.global.unsubscribed).toBe(true);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId: "camp-B",
          items: [{ email: "shared@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.contacted).toBe(true);
      expect(r.campaign.delivered).toBe(false);
      expect(r.brand.contacted).toBe(true);
      expect(r.brand.delivered).toBe(true);
    });

    it("should return singular leadId for an email", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        toEmail: "same-lead@test.com",
        leadId: "lead-same",
        brandId,
        campaignId: "camp-leads",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "same-lead@test.com",
        leadId: "lead-same",
        brandId,
        campaignId: "camp-leads",
      });

      const response = await request(app)
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId: "camp-leads",
          items: [{ email: "same-lead@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.leadId).toBe("lead-same");
    });

    it("should accept items without leadId", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-no-lead";
      await insertTestSending({
        messageId,
        toEmail: "nolead@test.com",
        leadId: "lead-found",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "nolead@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "nolead@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.email).toBe("nolead@test.com");
      expect(r.leadId).toBe("lead-found");
      expect(r.campaign.contacted).toBe(true);
      expect(r.campaign.delivered).toBe(true);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [
            { email: "a@test.com" },
            { email: "b@test.com" },
            { email: "c@test.com" },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(3);

      const aResult = response.body.results.find((r: any) => r.email === "a@test.com");
      const bResult = response.body.results.find((r: any) => r.email === "b@test.com");
      const cResult = response.body.results.find((r: any) => r.email === "c@test.com");

      expect(aResult.campaign.contacted).toBe(true);
      expect(aResult.campaign.delivered).toBe(true);
      expect(bResult.campaign.contacted).toBe(true);
      expect(bResult.campaign.delivered).toBe(false);
      expect(cResult.campaign.contacted).toBe(false);
      expect(cResult.campaign.delivered).toBe(false);
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          items: [{ email: "nocampaign@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign).toBeNull();
      expect(r.brand.contacted).toBe(true);
    });

    it("should always return replied=false and replyClassification=null", async () => {
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
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "reply@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.replied).toBe(false);
      expect(r.campaign.replyClassification).toBeNull();
      expect(r.brand.replied).toBe(false);
      expect(r.brand.replyClassification).toBeNull();
      expect(r.global.replied).toBe(false);
      expect(r.global.replyClassification).toBeNull();
    });

    it("should detect opened status via openings table", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-open";
      await insertTestSending({
        messageId,
        toEmail: "opener@test.com",
        leadId: "lead-opener",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "opener@test.com");
      await insertTestOpening(messageId);

      const response = await request(app)
        .post("/orgs/status")
        .set(statusHeaders())
        .send({
          campaignId,
          items: [{ email: "opener@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.opened).toBe(true);
      expect(r.brand.opened).toBe(true);
      expect(r.global.opened).toBe(true);
    });
  });
});
