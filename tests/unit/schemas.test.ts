import { describe, it, expect } from "vitest";
import {
  SendEmailRequestSchema,
  BatchSendRequestSchema,
  StatsQuerySchema,
  StatusRequestSchema,
  StatusScopeSchema,
  GlobalStatusSchema,
  RecipientStatsSchema,
  EmailStatsSchema,
  RepliesDetailSchema,
  StepStatsSchema,
  ChannelStatsSchema,
  ProviderStatusSchema,
  ReplyClassificationSchema,
} from "../../src/schemas";
import * as contract from "@shamanic-technologies/email-domain-contract";

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

    it("should strip unknown singular workflowSlug field", () => {
      const result = StatsQuerySchema.safeParse({
        orgId: "org_123",
        workflowSlug: "outbound-v2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty("workflowSlug");
      }
    });

    it("should strip unknown singular featureSlug field", () => {
      const result = StatsQuerySchema.safeParse({
        orgId: "org_123",
        featureSlug: "sales-cold-email-outreach",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty("featureSlug");
      }
    });

    it("should accept groupBy with valid enum values", () => {
      for (const value of ["brandId", "campaignId", "workflowSlug", "recipientEmail"]) {
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

    it("should accept featureSlugs as comma-separated string", () => {
      const result = StatsQuerySchema.safeParse({
        featureSlugs: "sales-cold-email-outreach,marketing-newsletter",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.featureSlugs).toBe("sales-cold-email-outreach,marketing-newsletter");
      }
    });

    it("should accept workflowSlugs as comma-separated string", () => {
      const result = StatsQuerySchema.safeParse({
        workflowSlugs: "wf-alpha,wf-beta",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlugs).toBe("wf-alpha,wf-beta");
      }
    });

    it("should accept featureSlugs alongside other filters", () => {
      const result = StatsQuerySchema.safeParse({
        brandId: "brand_123",
        featureSlugs: "sales-cold-email-outreach",
        groupBy: "workflowSlug",
      });
      expect(result.success).toBe(true);
    });

    it("should accept single-value workflowSlugs (no comma)", () => {
      const result = StatsQuerySchema.safeParse({
        workflowSlugs: "outbound-v2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.workflowSlugs).toBe("outbound-v2");
      }
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
    it("should accept valid request with campaignId and items (brandId now from header)", () => {
      const result = StatusRequestSchema.safeParse({
        campaignId: "camp_456",
        items: [{ leadId: "lead_1", email: "a@test.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("should accept valid request without campaignId", () => {
      const result = StatusRequestSchema.safeParse({
        items: [{ leadId: "lead_1", email: "a@test.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty items array", () => {
      const result = StatusRequestSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid email format in items", () => {
      const result = StatusRequestSchema.safeParse({
        items: [{ leadId: "lead_1", email: "not-an-email" }],
      });
      expect(result.success).toBe(false);
    });

    it("should accept item without leadId (leadId is optional)", () => {
      const result = StatusRequestSchema.safeParse({
        items: [{ email: "a@test.com" }],
      });
      expect(result.success).toBe(true);
    });

    it("should accept arrays larger than 1000 items (no upper cap)", () => {
      const items = Array.from({ length: 2000 }, (_, i) => ({
        email: `user${i}@test.com`,
      }));
      const result = StatusRequestSchema.safeParse({ items });
      expect(result.success).toBe(true);
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

  describe("Shared contract re-exports", () => {
    it("re-exports identical schema instances from email-domain-contract", () => {
      expect(ReplyClassificationSchema).toBe(contract.ReplyClassificationSchema);
      expect(RepliesDetailSchema).toBe(contract.RepliesDetailSchema);
      expect(RecipientStatsSchema).toBe(contract.RecipientStatsSchema);
      expect(StepStatsSchema).toBe(contract.StepStatsSchema);
      expect(EmailStatsSchema).toBe(contract.EmailStatsSchema);
      expect(ChannelStatsSchema).toBe(contract.ChannelStatsSchema);
      expect(StatusScopeSchema).toBe(contract.StatusScopeSchema);
      expect(GlobalStatusSchema).toBe(contract.GlobalStatusSchema);
      expect(ProviderStatusSchema).toBe(contract.ProviderStatusSchema);
    });

    const validScopeWithCancelled = {
      contacted: true,
      sent: true,
      delivered: true,
      opened: false,
      clicked: false,
      replied: false,
      replyClassification: null,
      bounced: false,
      unsubscribed: false,
      cancelled: false,
      lastDeliveredAt: "2026-03-02T12:00:00.000Z",
    };

    it("StatusScopeSchema accepts payload with cancelled padded to false", () => {
      const result = StatusScopeSchema.safeParse(validScopeWithCancelled);
      expect(result.success).toBe(true);
    });

    it("StatusScopeSchema accepts payload without cancelled (optional in contract v1)", () => {
      const { cancelled, ...withoutCancelled } = validScopeWithCancelled;
      const result = StatusScopeSchema.safeParse(withoutCancelled);
      expect(result.success).toBe(true);
    });

    const validRecipientStatsWithNotSending = {
      contacted: 1,
      sent: 1,
      delivered: 1,
      opened: 0,
      bounced: 0,
      clicked: 0,
      unsubscribed: 0,
      notSending: 0,
      repliesPositive: 0,
      repliesNegative: 0,
      repliesNeutral: 0,
      repliesAutoReply: 0,
      repliesDetail: {
        interested: 0,
        meetingBooked: 0,
        closed: 0,
        notInterested: 0,
        wrongPerson: 0,
        unsubscribe: 0,
        neutral: 0,
        autoReply: 0,
        outOfOffice: 0,
      },
    };

    it("RecipientStatsSchema accepts payload with notSending padded to 0", () => {
      const result = RecipientStatsSchema.safeParse(validRecipientStatsWithNotSending);
      expect(result.success).toBe(true);
    });

    it("RecipientStatsSchema accepts payload without notSending (optional in contract v1)", () => {
      const { notSending, ...withoutNotSending } = validRecipientStatsWithNotSending;
      const result = RecipientStatsSchema.safeParse(withoutNotSending);
      expect(result.success).toBe(true);
    });

    it("ReplyClassificationSchema accepts the three contract values", () => {
      expect(ReplyClassificationSchema.safeParse("positive").success).toBe(true);
      expect(ReplyClassificationSchema.safeParse("negative").success).toBe(true);
      expect(ReplyClassificationSchema.safeParse("neutral").success).toBe(true);
      expect(ReplyClassificationSchema.safeParse("other").success).toBe(false);
    });
  });
});
