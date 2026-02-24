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

  describe("GET /status/by-lead/:leadId", () => {
    it("should return 404 for non-existent lead", async () => {
      const response = await request(app)
        .get("/status/by-lead/non-existent-lead")
        .set(getAuthHeaders());

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("No email found for lead");
    });

    it("should return status 'sent' for lead with sending only", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId, leadId: "lead-abc" });

      const response = await request(app)
        .get("/status/by-lead/lead-abc")
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.messageId).toBe(messageId);
      expect(response.body.status).toBe("sent");
    });

    it("should return delivered status when delivery exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({ messageId, leadId: "lead-delivered" });
      await insertTestDelivery(messageId);

      const response = await request(app)
        .get("/status/by-lead/lead-delivered")
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("delivered");
      expect(response.body.delivery).not.toBeNull();
    });

    it("should return the most recent sending when lead has multiple emails", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      await insertTestSending({
        messageId: msg1,
        leadId: "lead-multi",
        subject: "First email",
      });
      await insertTestSending({
        messageId: msg2,
        leadId: "lead-multi",
        subject: "Second email",
      });

      const response = await request(app)
        .get("/status/by-lead/lead-multi")
        .set(getAuthHeaders());

      expect(response.status).toBe(200);
      expect(response.body.messageId).toBe(msg2);
    });
  });

  describe("POST /status/by-email", () => {
    it("should return 400 for invalid request", async () => {
      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({});

      expect(response.status).toBe(400);
    });

    it("should return empty results for emails not in campaign", async () => {
      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["nobody@test.com"],
          campaignId: "camp-empty",
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0].sent).toBe(false);
      expect(response.body.results[0].delivered).toBe(false);
    });

    it("should return sent=true, delivered=false for sent-only email", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "alice@test.com",
        campaignId: "camp-dedup-1",
      });

      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["alice@test.com"],
          campaignId: "camp-dedup-1",
        });

      expect(response.status).toBe(200);
      expect(response.body.results[0].email).toBe("alice@test.com");
      expect(response.body.results[0].sent).toBe(true);
      expect(response.body.results[0].delivered).toBe(false);
      expect(response.body.results[0].deliveredAt).toBeNull();
    });

    it("should return delivered=true with deliveredAt when delivery exists", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "bob@test.com",
        campaignId: "camp-dedup-2",
      });
      await insertTestDelivery(messageId, "bob@test.com");

      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["bob@test.com"],
          campaignId: "camp-dedup-2",
        });

      expect(response.status).toBe(200);
      const result = response.body.results[0];
      expect(result.delivered).toBe(true);
      expect(result.deliveredAt).not.toBeNull();
    });

    it("should include leadId when available", async () => {
      const messageId = randomUUID();
      await insertTestSending({
        messageId,
        toEmail: "carol@test.com",
        campaignId: "camp-dedup-3",
        leadId: "lead-carol",
      });

      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["carol@test.com"],
          campaignId: "camp-dedup-3",
        });

      expect(response.status).toBe(200);
      expect(response.body.results[0].leadId).toBe("lead-carol");
    });

    it("should handle multiple emails in a single request", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();
      const campaignId = "camp-dedup-multi";

      await insertTestSending({ messageId: msg1, toEmail: "a@test.com", campaignId });
      await insertTestSending({ messageId: msg2, toEmail: "b@test.com", campaignId });
      await insertTestDelivery(msg1, "a@test.com");

      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["a@test.com", "b@test.com", "c@test.com"],
          campaignId,
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(3);

      const aResult = response.body.results.find((r: any) => r.email === "a@test.com");
      const bResult = response.body.results.find((r: any) => r.email === "b@test.com");
      const cResult = response.body.results.find((r: any) => r.email === "c@test.com");

      expect(aResult.sent).toBe(true);
      expect(aResult.delivered).toBe(true);
      expect(bResult.sent).toBe(true);
      expect(bResult.delivered).toBe(false);
      expect(cResult.sent).toBe(false);
      expect(cResult.delivered).toBe(false);
    });

    it("should scope results to the given campaignId", async () => {
      const msg1 = randomUUID();
      const msg2 = randomUUID();

      await insertTestSending({ messageId: msg1, toEmail: "shared@test.com", campaignId: "camp-A" });
      await insertTestSending({ messageId: msg2, toEmail: "shared@test.com", campaignId: "camp-B" });
      await insertTestDelivery(msg1, "shared@test.com");

      const response = await request(app)
        .post("/status/by-email")
        .set(getAuthHeaders())
        .send({
          emails: ["shared@test.com"],
          campaignId: "camp-B",
        });

      expect(response.status).toBe(200);
      const result = response.body.results[0];
      expect(result.sent).toBe(true);
      expect(result.delivered).toBe(false);
    });
  });
});
