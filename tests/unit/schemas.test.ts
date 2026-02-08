import { describe, it, expect } from "vitest";
import {
  SendEmailRequestSchema,
  BatchSendRequestSchema,
  StatsRequestSchema,
} from "../../src/schemas";

describe("Zod schemas", () => {
  describe("SendEmailRequestSchema", () => {
    const validRequest = {
      orgId: "org_123",
      runId: "run_456",
      brandId: "brand_789",
      appId: "app_012",
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
        orgId: "org_123",
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

    it("should default messageStream to broadcast", () => {
      const result = SendEmailRequestSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.messageStream).toBe("broadcast");
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

    it("should accept request without orgId (admin/lifecycle emails)", () => {
      const { orgId, ...noOrg } = validRequest;
      const result = SendEmailRequestSchema.safeParse(noOrg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.orgId).toBeUndefined();
      }
    });

    it("should accept request without brandId, appId, campaignId", () => {
      const { brandId, appId, campaignId, ...minimal } = validRequest;
      const result = SendEmailRequestSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });
  });

  describe("BatchSendRequestSchema", () => {
    const validEmail = {
      orgId: "org_123",
      runId: "run_456",
      brandId: "brand_789",
      appId: "app_012",
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

    it("should accept emails without orgId", () => {
      const { orgId, ...noOrg } = validEmail;
      const result = BatchSendRequestSchema.safeParse({
        emails: [noOrg],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("StatsRequestSchema", () => {
    it("should accept runIds filter", () => {
      const result = StatsRequestSchema.safeParse({
        runIds: ["run_1", "run_2"],
      });
      expect(result.success).toBe(true);
    });

    it("should accept clerkOrgId filter", () => {
      const result = StatsRequestSchema.safeParse({
        clerkOrgId: "org_123",
      });
      expect(result.success).toBe(true);
    });

    it("should accept empty object (validation of at least one filter is in route)", () => {
      const result = StatsRequestSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should accept multiple filters", () => {
      const result = StatsRequestSchema.safeParse({
        runIds: ["run_1"],
        brandId: "brand_123",
        campaignId: "camp_456",
      });
      expect(result.success).toBe(true);
    });
  });
});
