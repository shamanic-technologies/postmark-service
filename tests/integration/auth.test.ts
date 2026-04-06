import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getServiceHeaders } from "../helpers/test-app";

// Tests the apiKeyAuth + requireOrgId middleware
describe("Authentication", () => {
  const app = createTestApp();

  describe("Org-scoped endpoints", () => {
    it("should reject requests without X-API-Key header", async () => {
      const response = await request(app)
        .post("/orgs/send")
        .send({
          from: "test@example.com",
          to: "recipient@example.com",
          subject: "Test",
          htmlBody: "<p>Test</p>",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Missing API key");
    });

    it("should reject requests with invalid X-API-Key", async () => {
      const response = await request(app)
        .post("/orgs/send")
        .set("X-API-Key", "wrong-secret")
        .send({
          from: "test@example.com",
          to: "recipient@example.com",
          subject: "Test",
          htmlBody: "<p>Test</p>",
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Invalid API key");
    });

    it("should reject requests without x-org-id header", async () => {
      const response = await request(app)
        .post("/orgs/send")
        .set({
          "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
          "x-user-id": "test-user-id",
        })
        .send({
          from: "test@example.com",
          to: "recipient@example.com",
          subject: "Test",
          htmlBody: "<p>Test</p>",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required header: x-org-id");
    });
  });

  describe("Internal endpoints", () => {
    it("should accept requests with API key only (no identity headers)", async () => {
      const response = await request(app)
        .get("/internal/status/by-org/test-org")
        .set(getServiceHeaders());

      // Should not be 401 or 403 (may be 200 depending on data)
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });

    it("should reject internal requests without API key", async () => {
      const response = await request(app)
        .get("/internal/status/by-org/test-org");

      expect(response.status).toBe(401);
    });
  });

  describe("Public endpoints", () => {
    it("should serve /openapi.json without auth", async () => {
      const response = await request(app).get("/openapi.json");

      // Should not be 401 or 403 (openapi endpoint is public)
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });

  describe("Webhook endpoint", () => {
    it("should accept webhook requests without auth", async () => {
      const response = await request(app)
        .post("/webhooks/postmark")
        .send({ RecordType: "Invalid" });

      // Should not be 401 or 403 (webhook endpoint is public)
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });
});
