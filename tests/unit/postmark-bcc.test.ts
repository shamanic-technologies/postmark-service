import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing postmark-client
vi.mock("../../src/lib/key-client", () => ({
  getAppKey: vi.fn().mockResolvedValue({ provider: "postmark", key: "test-token" }),
}));

// Mock the postmark SDK before importing the module
const mockSendEmail = vi.fn();

vi.mock("postmark", () => {
  return {
    ServerClient: class MockServerClient {
      sendEmail = mockSendEmail;
    },
    Models: {
      LinkTrackingOptions: {
        HtmlAndText: "HtmlAndText",
      },
    },
  };
});

import { sendEmail } from "../../src/lib/postmark-client";

describe("postmark-client BCC behavior", () => {
  beforeEach(() => {
    mockSendEmail.mockReset();
    mockSendEmail.mockResolvedValue({
      MessageID: "test-id",
      SubmittedAt: new Date().toISOString(),
      ErrorCode: 0,
      Message: "OK",
    });
  });

  it("should always include kevin@mcpfactory.org in BCC", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Bcc: "kevin@mcpfactory.org",
      })
    );
  });

  it("should append kevin@mcpfactory.org to existing BCC", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
      bcc: "other@test.com",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Bcc: "other@test.com,kevin@mcpfactory.org",
      })
    );
  });
});
