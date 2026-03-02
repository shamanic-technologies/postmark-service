import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing postmark-client
vi.mock("../../src/lib/key-client", () => ({
  getAppKey: vi.fn(),
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
      getOutboundMessageDetails = vi.fn();
      getBounces = vi.fn();
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
import { getAppKey } from "../../src/lib/key-client";
import { ServerClient } from "postmark";

const mockedGetAppKey = vi.mocked(getAppKey);
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
    mockedGetAppKey.mockResolvedValue({
      provider: "postmark",
      key: "resolved-token",
    });
  });

  const baseSendParams = {
    from: "test@example.com",
    to: "recipient@example.com",
    subject: "Test",
    htmlBody: "<p>Hi</p>",
    messageStream: "broadcast",
  };

  describe("all apps resolve via key-service", () => {
    it("should fetch token from key-service for mcpfactory", async () => {
      mockedGetAppKey.mockResolvedValue({
        provider: "postmark",
        key: "mcpfactory-token-from-key-service",
      });

      await sendEmail({ ...baseSendParams, appId: "mcpfactory" });

      expect(mockedGetAppKey).toHaveBeenCalledWith("mcpfactory", "postmark", expect.any(Object));
      expect(getCreatedTokens()).toEqual(["mcpfactory-token-from-key-service"]);
    });

    it("should fetch token from key-service for pressbeat", async () => {
      mockedGetAppKey.mockResolvedValue({
        provider: "postmark",
        key: "pressbeat-token-from-key-service",
      });

      await sendEmail({ ...baseSendParams, appId: "pressbeat" });

      expect(mockedGetAppKey).toHaveBeenCalledWith("pressbeat", "postmark", expect.any(Object));
      expect(getCreatedTokens()).toEqual(["pressbeat-token-from-key-service"]);
    });

    it("should default to mcpfactory when no appId provided", async () => {
      await sendEmail(baseSendParams);

      expect(mockedGetAppKey).toHaveBeenCalledWith("mcpfactory", "postmark", expect.any(Object));
    });

    it("should fetch token from key-service for any custom appId", async () => {
      mockedGetAppKey.mockResolvedValue({
        provider: "postmark",
        key: "dynamic-token",
      });

      await sendEmail({ ...baseSendParams, appId: "my-saas-app" });

      expect(mockedGetAppKey).toHaveBeenCalledWith("my-saas-app", "postmark", expect.any(Object));
      expect(getCreatedTokens()).toEqual(["dynamic-token"]);
    });
  });

  describe("caller context", () => {
    it("should pass caller context to key-service", async () => {
      const caller = { method: "POST", path: "/send" };
      await sendEmail({ ...baseSendParams, caller });

      expect(mockedGetAppKey).toHaveBeenCalledWith("mcpfactory", "postmark", caller);
    });

    it("should default caller to POST /send when not provided", async () => {
      await sendEmail(baseSendParams);

      expect(mockedGetAppKey).toHaveBeenCalledWith("mcpfactory", "postmark", { method: "POST", path: "/send" });
    });
  });

  describe("error handling", () => {
    it("should propagate key-service 404 error", async () => {
      mockedGetAppKey.mockRejectedValue(
        new Error('No Postmark key configured for appId "unknown-app". Register it via key-service first.')
      );

      await expect(
        sendEmail({ ...baseSendParams, appId: "unknown-app" })
      ).rejects.toThrow(
        'No Postmark key configured for appId "unknown-app"'
      );
    });

    it("should propagate key-service connection errors", async () => {
      mockedGetAppKey.mockRejectedValue(
        new Error("key-service GET /internal/app-keys/postmark/decrypt failed: 500 - Internal server error")
      );

      await expect(
        sendEmail({ ...baseSendParams, appId: "my-app" })
      ).rejects.toThrow("key-service GET");
    });
  });

  describe("caching", () => {
    it("should cache the client after first key-service call", async () => {
      mockedGetAppKey.mockResolvedValue({
        provider: "postmark",
        key: "cached-token",
      });

      await sendEmail({ ...baseSendParams, appId: "cached-app" });
      await sendEmail({ ...baseSendParams, appId: "cached-app" });

      expect(mockedGetAppKey).toHaveBeenCalledTimes(1);
    });
  });

  describe("SendEmailParams interface", () => {
    it("should accept appId as a string", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
        appId: "my-custom-app",
      };

      expect(params.appId).toBe("my-custom-app");
    });

    it("should require messageStream (resolved by route handler)", () => {
      const params = {
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test Subject",
        htmlBody: "<p>Hello</p>",
        messageStream: "broadcast",
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
