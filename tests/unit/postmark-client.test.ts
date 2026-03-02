import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing postmark-client
vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn(),
}));

// Mock postmark SDK
const mockSendEmail = vi.fn().mockResolvedValue({
  ErrorCode: 0,
  MessageID: "test-msg-id",
  SubmittedAt: new Date().toISOString(),
  Message: "OK",
});

vi.mock("postmark", () => {
  return {
    ServerClient: class MockServerClient {
      _token: string;
      sendEmail = mockSendEmail;
      constructor(token: string) {
        this._token = token;
        MockServerClient._instances.push({ token });
      }
      static _instances: { token: string }[] = [];
    },
    Models: {
      LinkTrackingOptions: { HtmlAndText: "HtmlAndText" },
    },
  };
});

import { sendEmail, clearClientCache } from "../../src/lib/postmark-client";
import { getOrgKey } from "../../src/lib/key-client";
import { ServerClient } from "postmark";

const mockedGetOrgKey = vi.mocked(getOrgKey);
const MockedServerClient = ServerClient as any;

function getCreatedTokens(): string[] {
  return MockedServerClient._instances.map((i: any) => i.token);
}

describe("postmark-client key resolution", () => {
  beforeEach(() => {
    clearClientCache();
    vi.clearAllMocks();
    mockSendEmail.mockClear();
    MockedServerClient._instances = [];
    mockedGetOrgKey.mockResolvedValue({
      provider: "postmark",
      key: "resolved-token",
      keySource: "platform",
    });
  });

  const baseSendParams = {
    from: "test@example.com",
    to: "recipient@example.com",
    subject: "Test",
    htmlBody: "<p>Hi</p>",
    messageStream: "broadcast",
    orgId: "test-org",
    userId: "test-user",
  };

  describe("all orgs resolve via key-service", () => {
    it("should fetch token from key-service for an org", async () => {
      mockedGetOrgKey.mockResolvedValue({
        provider: "postmark",
        key: "org-token-from-key-service",
        keySource: "platform",
      });

      await sendEmail({ ...baseSendParams, orgId: "org-1", userId: "user-1" });

      expect(mockedGetOrgKey).toHaveBeenCalledWith("org-1", "user-1", "postmark", expect.any(Object));
      expect(getCreatedTokens()).toEqual(["org-token-from-key-service"]);
    });

    it("should fetch token from key-service for a different org", async () => {
      mockedGetOrgKey.mockResolvedValue({
        provider: "postmark",
        key: "other-org-token",
        keySource: "org",
      });

      await sendEmail({ ...baseSendParams, orgId: "org-2", userId: "user-2" });

      expect(mockedGetOrgKey).toHaveBeenCalledWith("org-2", "user-2", "postmark", expect.any(Object));
      expect(getCreatedTokens()).toEqual(["other-org-token"]);
    });
  });

  describe("caller context", () => {
    it("should pass caller context to key-service", async () => {
      const caller = { method: "POST", path: "/send" };
      await sendEmail({ ...baseSendParams, caller });

      expect(mockedGetOrgKey).toHaveBeenCalledWith("test-org", "test-user", "postmark", caller);
    });

    it("should default caller to POST /send when not provided", async () => {
      await sendEmail(baseSendParams);

      expect(mockedGetOrgKey).toHaveBeenCalledWith("test-org", "test-user", "postmark", { method: "POST", path: "/send" });
    });
  });

  describe("error handling", () => {
    it("should propagate key-service 404 error", async () => {
      mockedGetOrgKey.mockRejectedValue(
        new Error('No Postmark key configured for orgId "unknown-org". Register it via key-service first.')
      );

      await expect(
        sendEmail({ ...baseSendParams, orgId: "unknown-org" })
      ).rejects.toThrow(
        'No Postmark key configured for orgId "unknown-org"'
      );
    });

    it("should propagate key-service connection errors", async () => {
      mockedGetOrgKey.mockRejectedValue(
        new Error("key-service GET /keys/postmark/decrypt failed: 500 - Internal server error")
      );

      await expect(
        sendEmail(baseSendParams)
      ).rejects.toThrow("key-service GET");
    });
  });

  describe("caching", () => {
    it("should cache the client after first key-service call", async () => {
      mockedGetOrgKey.mockResolvedValue({
        provider: "postmark",
        key: "cached-token",
        keySource: "platform",
      });

      await sendEmail({ ...baseSendParams, orgId: "cached-org" });
      await sendEmail({ ...baseSendParams, orgId: "cached-org" });

      expect(mockedGetOrgKey).toHaveBeenCalledTimes(1);
    });
  });

  describe("SendEmailParams interface", () => {
    it("should accept orgId and userId", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
        messageStream: "broadcast",
        orgId: "my-org",
        userId: "my-user",
      };

      expect(params.orgId).toBe("my-org");
      expect(params.userId).toBe("my-user");
    });

    it("should require messageStream (resolved by route handler)", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
        messageStream: "broadcast",
        orgId: "my-org",
        userId: "my-user",
      };

      expect(params.messageStream).toBe("broadcast");
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
        orgId: "my-org",
        userId: "my-user",
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
});
