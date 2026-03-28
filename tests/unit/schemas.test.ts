import { describe, it, expect } from "vitest";
import {
  SendEmailRequestSchema,
  BatchSendRequestSchema,
  StatsQuerySchema,
  StatusRequestSchema,
} from "../../src/schemas";

describe("Zod schemas", () => {
  describe("SendEmailRequestSchema", () => {
    const validRequest = {
      brandId: "brand_789",
      campaignId: "camp_345",
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test Email",
      htmlBody: "<p>Hello</p>",
    };

    it("should accept a valid request", () => {
      const result = SendEmailRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it("should reject when missing required fields", () => {
      const result = SendEmailRequestSchema.safeParse({
        from: "sender@example.com",
      });
      expect(result.success).toBe(false);
    });

    it("should reject when neither htmlBody nor textBody provided", () => {
      const { htmlBody, ...noBody } = validRequest;
      const result = SendEmailRequestSchema.safeParse(noBody);
      expect(result.success).toBe(false);
    });

    it("should accept textBody without htmlBody", () => {
      const { htmlBody, ...rest } = validRequest;
      const result = SendEmailRequestSchema.safeParse({
        ...rest,
        textBody: "Hello",
      });
      expect(result.success).toBe(true);
    });

    it("should not accept messageStream field (resolved server-side via key-service)", () => {
      const result = SendEmailRequestSchema.safeParse({
        ...validRequest,
        messageStream: "broadcast",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty("messageStream");
      }
    });

    it("should validate trackLinks enum", () => {
      const result = SendEmailRequestSchema.safeParse({
        ...validRequest,
        trackLinks: "InvalidValue",
      });
      expect(result.success).toBe(false);
    });

    it("should accept valid trackLinks values", () => {
      for (const value of ["None", "HtmlAndText", "HtmlOnly", "TextOnly"]) {
        const result = SendEmailRequestSchema.safeParse({
          ...validRequest,
          trackLinks: value,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should accept request without brandId, campaignId", () => {
      const { brandId, campaignId, ...minimal } = validRequest;
      const result = SendEmailRequestSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    it("should accept request without from (resolved from key-service)", () => {
      const { from, ...noFrom } = validRequest;
      const result = SendEmailRequestSchema.safeParse(noFrom);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.from).toBeUndefined();
      }
    });

    it("should not accept parentRunId in body (comes from x-run-id header)", () => {
      const result = SendEmailRequestSchema.safeParse({
        ...validRequest,
        parentRunId: "run_456",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty("parentRunId");
      }
    });
  });

  describe("BatchSendRequestSchema", () => {
    const validEmail = {
      brandId: "brand_789",
      campaignId: "camp_345",
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    };

    it("should accept a valid batch", () => {
      const result = BatchSendRequestSchema.safeParse({
        emails: [validEmail],
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty emails array", () => {
      const result = BatchSendRequestSchema.safeParse({ emails: [] });
      expect(result.success).toBe(false);
    });

    it("should reject missing emails field", () => {
      const result = BatchSendRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject more than 500 emails", () => {
      const emails = Array(501).fill(validEmail);
      const result = BatchSendRequestSchema.safeParse({ emails });
      expect(result.success).toBe(false);
    });

    it("should accept batch email without from (resolved from key-service)", () => {
      const { from, ...noFrom } = validEmail;
      const result = BatchSendRequestSchema.safeParse({
        emails: [{ ...noFrom }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emails[0].from).toBeUndefined();
      }
    });

    it("should not accept parentRunId in batch email body (comes from x-run-id header)", () => {
      const result = BatchSendRequestSchema.safeParse({
        emails: [{ ...validEmail, parentRunId: "run_456" }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.emails[0]).not.toHaveProperty("parentRunId");
      }
    });
  });

  describe("StatsQuerySchema", () => {
    it("should accept runIds as comma-separated string", () => {
      const result = StatsQuerySchema.safeParse({
        runIds: "run_1,run_2",
      });
      expect(result.success).toBe(true);
    });

    it("should accept orgId filter", () => {
      const result = StatsQuerySchema.safeParse({
        orgId: "org_123",
      });
      expect(result.success).toBe(true);
    });

    it("should accept empty object (no filters = global stats)", () => {
      const result = StatsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should accept multiple filters", () => {
      const result = StatsQuerySchema.safeParse({
        runIds: "run_1",
        brandId: "brand_123",
        campaignId: "camp_456",
      });
      expect(result.success).toBe(true);
    });

    it("should accept workflowSlug filter", () => {
      const result = StatsQuerySchema.safeParse({
        orgId: "org_123",
        workflowSlug: "outbound-v2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBe("outbound-v2");
      }
    });

    it("should accept groupBy with valid enum values", () => {
      for (const value of ["brandId", "campaignId", "workflowSlug", "leadEmail"]) {
        const result = StatsQuerySchema.safeParse({
          orgId: "org_123",
          groupBy: value,
        });
        expect(result.success).toBe(true);
      }
    });

    it("should reject invalid groupBy value", () => {
      const result = StatsQuerySchema.safeParse({
        orgId: "org_123",
        groupBy: "invalidDimension",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SendEmailRequestSchema - leadId", () => {
    const validRequest = {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test Email",
      htmlBody: "<p>Hello</p>",
    };

    it("should accept leadId as optional field", () => {
      const result = SendEmailRequestSchema.safeParse({
        ...validRequest,
        leadId: "lead_123",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.leadId).toBe("lead_123");
      }
    });

    it("should accept request without leadId", () => {
      const result = SendEmailRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.leadId).toBeUndefined();
      }
    });
  });

  describe("StatusRequestSchema", () => {
    it("should accept valid request with brandId, campaignId, and items", () => {
      const result = StatusRequestSchema.safeParse({
        brandId: "brand_123",
        campaignId: "camp_456",
        items: [{ leadId: "lead_1", email: "a@test.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("should accept valid request without campaignId", () => {
      const result = StatusRequestSchema.safeParse({
        brandId: "brand_123",
        items: [{ leadId: "lead_1", email: "a@test.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty items array", () => {
      const result = StatusRequestSchema.safeParse({
        brandId: "brand_123",
        items: [],
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing brandId", () => {
      const result = StatusRequestSchema.safeParse({
        items: [{ leadId: "lead_1", email: "a@test.com" }],
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid email format in items", () => {
      const result = StatusRequestSchema.safeParse({
        brandId: "brand_123",
        items: [{ leadId: "lead_1", email: "not-an-email" }],
      });
      expect(result.success).toBe(false);
    });

    it("should reject item missing leadId", () => {
      const result = StatusRequestSchema.safeParse({
        brandId: "brand_123",
        items: [{ email: "a@test.com" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SendEmailRequestSchema - workflowSlug", () => {
    const validRequest = {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test Email",
      htmlBody: "<p>Hello</p>",
    };

    it("should accept workflowSlug as optional field", () => {
      const result = SendEmailRequestSchema.safeParse({
        ...validRequest,
        workflowSlug: "outbound-v2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBe("outbound-v2");
      }
    });

    it("should accept request without workflowSlug", () => {
      const result = SendEmailRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlug).toBeUndefined();
      }
    });
  });
});
