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

    it("should accept requests with valid X-API-Key", async () => {
      const response = await request(app)
        .get("/status/by-org/test-org")
        .set(getAuthHeaders());

      // Should not be 401 or 403 (may be 200 or 404 depending on data)
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
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
