import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("OpenAPI spec", () => {
  const specPath = path.resolve(__dirname, "../../openapi.json");

  it("should have a generated openapi.json file", () => {
    expect(fs.existsSync(specPath)).toBe(true);
  });

  it("should be valid OpenAPI 3.0", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Postmark Service API");
    expect(spec.info.version).toBe("1.0.0");
  });

  it("should include all service paths", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    const paths = Object.keys(spec.paths);

    expect(paths).toContain("/");
    expect(paths).toContain("/health");
    expect(paths).toContain("/send");
    expect(paths).toContain("/send/batch");
    expect(paths).toContain("/status/{messageId}");
    expect(paths).toContain("/status/by-org/{orgId}");
    expect(paths).toContain("/status/by-run/{runId}");
    expect(paths).toContain("/stats");
    expect(paths).toContain("/webhooks/postmark");
  });

  it("should include component schemas", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    const schemas = Object.keys(spec.components.schemas);

    expect(schemas).toContain("SendEmailRequest");
    expect(schemas).toContain("SendEmailResponse");
    expect(schemas).toContain("BatchSendRequest");
    expect(schemas).toContain("BatchSendResponse");
    expect(schemas).toContain("EmailStatus");
    expect(schemas).toContain("StatsRequest");
    expect(schemas).toContain("StatsResponse");
  });

  it("should have correct schema structure for SendEmailRequest", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    const schema = spec.components.schemas.SendEmailRequest;

    expect(schema.type).toBe("object");
    expect(schema.required).toContain("orgId");
    expect(schema.required).toContain("from");
    expect(schema.required).toContain("to");
    expect(schema.required).toContain("subject");
    expect(schema.properties.orgId.type).toBe("string");
    expect(schema.properties.messageStream.default).toBe("broadcast");
  });

  it("should include security scheme", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));

    expect(spec.components.securitySchemes.apiKey).toBeDefined();
    expect(spec.components.securitySchemes.apiKey.type).toBe("apiKey");
    expect(spec.components.securitySchemes.apiKey.name).toBe("X-API-Key");
    expect(spec.components.securitySchemes.apiKey.in).toBe("header");
  });

  it("should have tags for all route groups", () => {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    const tagNames = spec.tags.map((t: { name: string }) => t.name);

    expect(tagNames).toContain("Health");
    expect(tagNames).toContain("Email Sending");
    expect(tagNames).toContain("Email Status");
    expect(tagNames).toContain("Webhooks");
  });
});
