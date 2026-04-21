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
  insertTestLinkClick,
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

    it("should return Layer 2 status for message with only sending record", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.messageId).toBe(messageId);
      expect(response.body.status.contacted).toBe(true);
      expect(response.body.status.sent).toBe(true);
      expect(response.body.status.delivered).toBe(false);
      expect(response.body.status.opened).toBe(false);
      expect(response.body.status.clicked).toBe(false);
      expect(response.body.status.bounced).toBe(false);
    });

    it("should return delivered=true when delivery exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestDelivery(messageId);

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status.delivered).toBe(true);
      expect(response.body.status.sent).toBe(true);
      expect(response.body.status.lastDeliveredAt).not.toBeNull();
    });

    it("should return bounced=true and delivered=false when bounce exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestBounce(messageId);

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status.bounced).toBe(true);
      expect(response.body.status.sent).toBe(true);
      expect(response.body.status.delivered).toBe(false);
    });

    it("should return opened=true when opening exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      await insertTestDelivery(messageId);
      await insertTestOpening(messageId);

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status.opened).toBe(true);
      expect(response.body.status.delivered).toBe(true);
      expect(response.body.status.sent).toBe(true);
    });

    it("should imply opened and delivered when click exists without open/delivery webhooks", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId });
      // Only click, no delivery or open webhooks
      await insertTestLinkClick(messageId);

      const response = await request(app)
        .get(`/internal/status/${messageId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status.clicked).toBe(true);
      expect(response.body.status.opened).toBe(true);
      expect(response.body.status.delivered).toBe(true);
      expect(response.body.status.sent).toBe(true);
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

    it("should return emails for org with Layer 2 status", async () => {
      const orgId = "test-org-123";
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({ messageId: msg1, orgId });
      await insertTestSending({ messageId: msg2, orgId });
      await insertTestDelivery(msg1);

      const response = await request(app)
        .get(`/internal/status/by-org/${orgId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.orgId).toBe(orgId);
      expect(response.body.count).toBe(2);
      expect(response.body.emails.length).toBe(2);
      // Each email should have a status object
      const delivered = response.body.emails.find((e: any) => e.messageId === msg1);
      expect(delivered.status.contacted).toBe(true);
      expect(delivered.status.delivered).toBe(true);
      const notDelivered = response.body.emails.find((e: any) => e.messageId === msg2);
      expect(notDelivered.status.delivered).toBe(false);
    });

    it("should return all results when limit is omitted", async () => {
      const orgId = "test-org-no-limit";
      // Insert more than the old silent default of 50
      const insertions = Array.from({ length: 55 }, () =>
        insertTestSending({ messageId: randomUUID(), orgId })
      );
      await Promise.all(insertions);

      const response = await request(app)
        .get(`/internal/status/by-org/${orgId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(55);
      expect(response.body.emails.length).toBe(55);
    });

    it("should return all results when limit is omitted", async () => {
      const orgId = "test-org-no-limit";
      // Insert more than the old silent default of 50
      const insertions = Array.from({ length: 55 }, () =>
        insertTestSending({ messageId: randomUUID(), orgId })
      );
      await Promise.all(insertions);

      const response = await request(app)
        .get(`/internal/status/by-org/${orgId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.count).toBe(55);
      expect(response.body.emails.length).toBe(55);
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
    it("should return emails for run with Layer 2 status", async () => {
      const runId = "run-123";
      const msg1 = randomUUID();
      await insertTestSending({ messageId: msg1, runId });
      await insertTestSending({ messageId: randomUUID(), runId });
      await insertTestDelivery(msg1);

      const response = await request(app)
        .get(`/internal/status/by-run/${runId}`)
        .set(getServiceHeaders());

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe(runId);
      expect(response.body.total).toBe(2);
      const delivered = response.body.emails.find((e: any) => e.messageId === msg1);
      expect(delivered.status.delivered).toBe(true);
      expect(delivered.status.sent).toBe(true);
    });
  });

  describe("POST /orgs/status", () => {
    const brandId = "brand-test";

    it("should return 400 for invalid request body", async () => {
      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({});

      expect(response.status).toBe(400);
    });

    // ── Global-only mode (no brandIds, no campaignId) ──────────────────

    it("should return global-only mode when neither brandIds nor campaignId provided", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "globalonly@test.com",
        brandId,
        campaignId: "camp-x",
      });

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          items: [{ email: "globalonly@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign).toBeNull();
      expect(r.brand).toBeNull();
      expect(r.campaign).toBeNull();
      expect(r.global).toEqual({ email: { bounced: false, unsubscribed: false } });
    });

    it("should return global bounced=true when email has bounced", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId, toEmail: "gbounce@test.com" });
      await insertTestBounce(messageId, "gbounce@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          items: [{ email: "gbounce@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.global.email.bounced).toBe(true);
      expect(r.global.email.unsubscribed).toBe(false);
    });

    it("should return global unsubscribed=true when email has unsubscribed", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId, toEmail: "gunsub@test.com" });
      await insertTestSubscriptionChange(messageId, "gunsub@test.com", true);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          items: [{ email: "gunsub@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.global.email.unsubscribed).toBe(true);
    });

    // ── Campaign mode (campaignId provided) ───────────────────────────

    it("should return campaign mode when campaignId provided", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-mode";
      await insertTestSending({
        messageId,
        toEmail: "camp@test.com",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "camp@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId,
          items: [{ email: "camp@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign).toBeNull();
      expect(r.brand).toBeNull();
      expect(r.campaign).not.toBeNull();
      expect(r.campaign.contacted).toBe(true);
      expect(r.campaign.delivered).toBe(true);
      expect(r.campaign.lastDeliveredAt).not.toBeNull();
      expect(r.global).toEqual({ email: { bounced: false, unsubscribed: false } });
    });

    it("should return all-false campaign scope for unknown email", async () => {
      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId: "camp-empty",
          items: [{ email: "nobody@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.contacted).toBe(false);
      expect(r.campaign.sent).toBe(false);
      expect(r.campaign.delivered).toBe(false);
      expect(r.campaign.opened).toBe(false);
      expect(r.campaign.clicked).toBe(false);
      expect(r.campaign.replied).toBe(false);
      expect(r.campaign.replyClassification).toBeNull();
      expect(r.campaign.bounced).toBe(false);
      expect(r.campaign.unsubscribed).toBe(false);
    });

    it("should use campaign mode when both brandIds and campaignId provided (brandIds ignored)", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-both";
      await insertTestSending({
        messageId,
        toEmail: "both@test.com",
        brandId,
        campaignId,
      });
      await insertTestDelivery(messageId, "both@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          campaignId,
          items: [{ email: "both@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign).toBeNull();
      expect(r.brand).toBeNull();
      expect(r.campaign).not.toBeNull();
      expect(r.campaign.contacted).toBe(true);
    });

    it("should detect bounces in campaign scope", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-bounce";
      await insertTestSending({
        messageId,
        toEmail: "bounced@test.com",
        campaignId,
      });
      await insertTestBounce(messageId, "bounced@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId,
          items: [{ email: "bounced@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.bounced).toBe(true);
      expect(r.global.email.bounced).toBe(true);
    });

    it("should detect opened in campaign scope", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-open";
      await insertTestSending({
        messageId,
        toEmail: "opener@test.com",
        campaignId,
      });
      await insertTestDelivery(messageId, "opener@test.com");
      await insertTestOpening(messageId);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId,
          items: [{ email: "opener@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.opened).toBe(true);
    });

    it("should detect clicked in campaign scope", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-click";
      await insertTestSending({
        messageId,
        toEmail: "clicker@test.com",
        campaignId,
      });
      await insertTestDelivery(messageId, "clicker@test.com");
      await insertTestLinkClick(messageId);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId,
          items: [{ email: "clicker@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.clicked).toBe(true);
    });

    it("should detect clicked in brand mode with BOOL_OR aggregation", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        toEmail: "brand-clicker@test.com",
        brandId,
        campaignId: "camp-click-yes",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "brand-clicker@test.com",
        brandId,
        campaignId: "camp-click-no",
      });
      await insertTestDelivery(msg1, "brand-clicker@test.com");
      await insertTestLinkClick(msg1);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "brand-clicker@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign["camp-click-yes"].clicked).toBe(true);
      expect(r.byCampaign["camp-click-no"].clicked).toBe(false);
      expect(r.brand.clicked).toBe(true);
    });

    it("should always return replied=false and replyClassification=null", async () => {
      const messageId = randomUUID();
      const campaignId = "camp-reply";
      await insertTestSending({
        messageId,
        toEmail: "reply@test.com",
        campaignId,
      });
      await insertTestDelivery(messageId, "reply@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId,
          items: [{ email: "reply@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign.replied).toBe(false);
      expect(r.campaign.replyClassification).toBeNull();
    });

    it("should handle multiple items in a single request", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      const campaignId = "camp-batch";

      await insertTestSending({ messageId: msg1, toEmail: "a@test.com", campaignId });
      await insertTestSending({ messageId: msg2, toEmail: "b@test.com", campaignId });
      await insertTestDelivery(msg1, "a@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
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

    // ── Brand mode (brandIds provided, no campaignId) ──────────────────

    it("should return brand mode with byCampaign breakdown when brandIds provided", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        toEmail: "alice@test.com",
        brandId,
        campaignId: "camp-A",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "alice@test.com",
        brandId,
        campaignId: "camp-B",
      });
      await insertTestDelivery(msg1, "alice@test.com");
      await insertTestOpening(msg2);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "alice@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.campaign).toBeNull();
      expect(r.byCampaign).not.toBeNull();
      expect(r.byCampaign["camp-A"]).toBeDefined();
      expect(r.byCampaign["camp-A"].contacted).toBe(true);
      expect(r.byCampaign["camp-A"].delivered).toBe(true);
      expect(r.byCampaign["camp-B"]).toBeDefined();
      expect(r.byCampaign["camp-B"].contacted).toBe(true);
      expect(r.byCampaign["camp-B"].opened).toBe(true);
      // Brand aggregation = BOOL_OR across campaigns
      expect(r.brand.contacted).toBe(true);
      expect(r.brand.delivered).toBe(true);
      expect(r.brand.opened).toBe(true);
    });

    it("should return brand scope with BOOL_OR aggregation", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      // Camp-A: delivered only. Camp-B: bounced only.
      await insertTestSending({
        messageId: msg1,
        toEmail: "bool-or@test.com",
        brandId,
        campaignId: "camp-deliver",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "bool-or@test.com",
        brandId,
        campaignId: "camp-bounce",
      });
      await insertTestDelivery(msg1, "bool-or@test.com");
      await insertTestBounce(msg2, "bool-or@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "bool-or@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      // Brand should show both delivered AND bounced (from different campaigns)
      expect(r.brand.delivered).toBe(true);
      expect(r.brand.bounced).toBe(true);
      // byCampaign should show them separately
      expect(r.byCampaign["camp-deliver"].delivered).toBe(true);
      expect(r.byCampaign["camp-deliver"].bounced).toBe(false);
      expect(r.byCampaign["camp-bounce"].bounced).toBe(true);
      expect(r.byCampaign["camp-bounce"].delivered).toBe(false);
    });

    it("should return byCampaign=null when brand has no campaign-linked sendings", async () => {
      const messageId = randomUUID();
      // Sending with brandIds but no campaignId
      await insertTestSending({
        messageId,
        toEmail: "nocamp-brand@test.com",
        brandId,
      });

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "nocamp-brand@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign).toBeNull();
      expect(r.brand.contacted).toBe(true);
    });

    it("should not include sendings from other brands in brand mode", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        toEmail: "multi-brand@test.com",
        brandId,
        campaignId: "camp-mine",
      });
      await insertTestSending({
        messageId: msg2,
        toEmail: "multi-brand@test.com",
        brandId: "other-brand",
        campaignId: "camp-other",
      });
      await insertTestDelivery(msg1, "multi-brand@test.com");
      await insertTestBounce(msg2, "multi-brand@test.com");

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "multi-brand@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      // Only camp-mine should appear in byCampaign
      expect(r.byCampaign["camp-mine"]).toBeDefined();
      expect(r.byCampaign["camp-other"]).toBeUndefined();
      // Brand scope should only reflect brandIds's sendings
      expect(r.brand.delivered).toBe(true);
      expect(r.brand.bounced).toBe(false);
      // Global should reflect ALL sendings (cross-brand)
      expect(r.global.email.bounced).toBe(true);
    });

    it("should detect unsubscribes in brand mode", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "unsub-brand@test.com",
        brandId,
        campaignId: "camp-unsub-brand",
      });
      await insertTestSubscriptionChange(messageId, "unsub-brand@test.com", true);

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          brandIds: [brandId],
          items: [{ email: "unsub-brand@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r.byCampaign["camp-unsub-brand"].unsubscribed).toBe(true);
      expect(r.brand.unsubscribed).toBe(true);
      expect(r.global.email.unsubscribed).toBe(true);
    });

    // ── Response shape: no leadId ─────────────────────────────────────

    it("should not include leadId in the response", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "nolead@test.com",
        leadId: "lead-shouldnt-appear",
        campaignId: "camp-nolead",
      });

      const response = await request(app)
        .post("/orgs/status")
        .set(getAuthHeaders())
        .send({
          campaignId: "camp-nolead",
          items: [{ email: "nolead@test.com" }],
        });

      expect(response.status).toBe(200);
      const r = response.body.results[0];
      expect(r).not.toHaveProperty("leadId");
    });
  });
});
