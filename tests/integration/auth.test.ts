import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

// Tests the serviceAuth middleware (src/middleware/serviceAuth.ts)
describe("Authentication", () => {
  const app = createTestApp();

  describe("Protected endpoints", () => {
    it("should reject requests without X-API-Key header", async () => {
      const response = await request(app)
        .post("/send")
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
        .post("/send")
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

    it("should accept requests with valid X-API-Key and identity headers", async () => {
      const response = await request(app)
        .get("/status/by-org/test-org")
        .set(getAuthHeaders());

      // Should not be 401, 403, or 400 (may be 200 or 404 depending on data)
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(400);
    });
  });

  describe("Identity headers", () => {
    it("should reject requests without x-org-id header", async () => {
      const response = await request(app)
        .get("/status/by-org/test-org")
        .set({
          "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
          "x-user-id": "test-user-id",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required header: x-org-id");
    });

    it("should reject requests without x-user-id header", async () => {
      const response = await request(app)
        .get("/status/by-org/test-org")
        .set({
          "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
          "x-org-id": "test-org-id",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required header: x-user-id");
    });

    it("should reject requests without x-run-id header", async () => {
      const response = await request(app)
        .get("/status/by-org/test-org")
        .set({
          "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
          "x-org-id": "test-org-id",
          "x-user-id": "test-user-id",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing required header: x-run-id");
    });
  });

  describe("OpenAPI endpoint", () => {
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
