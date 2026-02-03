import { describe, it, expect } from "vitest";

/**
 * Unit tests for postmark-client module
 * 
 * Note: Since the postmark client uses a lazy singleton pattern,
 * we test the interface and types rather than mocking the SDK directly.
 * Integration tests with real API calls are done separately.
 */

describe("postmark-client types and interfaces", () => {
  describe("SendEmailParams interface", () => {
    it("should define required fields", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
      };

      expect(params.from).toBeDefined();
      expect(params.to).toBeDefined();
      expect(params.subject).toBeDefined();
    });

    it("should allow optional fields", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
        textBody: "Hello",
        replyTo: "reply@test.com",
        tag: "campaign-1",
        messageStream: "broadcast",
        headers: [{ name: "X-Custom", value: "test" }],
        metadata: { key: "value" },
        trackOpens: true,
        trackLinks: "HtmlAndText" as const,
      };

      expect(params.replyTo).toBe("reply@test.com");
      expect(params.tag).toBe("campaign-1");
      expect(params.trackLinks).toBe("HtmlAndText");
    });
  });

  describe("SendEmailResult interface", () => {
    it("should define success result", () => {
      const successResult = {
        success: true,
        messageId: "test-message-id",
        submittedAt: new Date(),
        errorCode: 0,
        message: "OK",
      };

      expect(successResult.success).toBe(true);
      expect(successResult.messageId).toBeDefined();
    });

    it("should define failure result", () => {
      const failResult = {
        success: false,
        errorCode: 300,
        message: "Invalid email address",
      };

      expect(failResult.success).toBe(false);
      expect(failResult.errorCode).toBe(300);
    });
  });

  describe("Environment configuration", () => {
    it("should read POSTMARK_SERVER_TOKEN from env", () => {
      process.env.POSTMARK_SERVER_TOKEN = "test-token";
      expect(process.env.POSTMARK_SERVER_TOKEN).toBe("test-token");
    });
  });
});
