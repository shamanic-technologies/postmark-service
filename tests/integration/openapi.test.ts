import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

describe("OpenAPI endpoint", () => {
  const app = createTestApp();

  describe("GET /openapi.json", () => {
    it("should return OpenAPI spec without auth", async () => {
      const response = await request(app).get("/openapi.json");

      expect(response.status).toBe(200);
      expect(response.body.openapi).toBe("3.0.0");
      expect(response.body.info.title).toBe("Postmark Service API");
    });

    it("should include all paths", async () => {
      const response = await request(app).get("/openapi.json");

      const paths = Object.keys(response.body.paths);
      expect(paths).toContain("/send");
      expect(paths).toContain("/health");
      expect(paths).toContain("/webhooks/postmark");
    });

    it("should include component schemas", async () => {
      const response = await request(app).get("/openapi.json");

      expect(response.body.components.schemas.SendEmailRequest).toBeDefined();
      expect(response.body.components.schemas.SendEmailResponse).toBeDefined();
    });

    it("should return valid JSON content type", async () => {
      const response = await request(app).get("/openapi.json");

      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });
  });
});
