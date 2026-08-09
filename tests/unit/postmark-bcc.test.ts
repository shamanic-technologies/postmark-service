import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock key-client before importing postmark-client
vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn().mockResolvedValue({ provider: "postmark", key: "test-token", keySource: "platform" }),
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

  it("should send no BCC when the caller supplied none", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
      messageStream: "broadcast",
      orgId: "test-org",
      userId: "test-user",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Bcc: undefined,
      })
    );
  });

  it("should forward the caller-supplied BCC byte-equal, with nothing appended", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
      messageStream: "broadcast",
      bcc: "other@test.com",
      orgId: "test-org",
      userId: "test-user",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Bcc: "other@test.com",
      })
    );
  });

  it("should forward a multi-address caller BCC list unchanged", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
      messageStream: "broadcast",
      bcc: "a@test.com,b@test.com",
      orgId: "test-org",
      userId: "test-user",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        Bcc: "a@test.com,b@test.com",
      })
    );
  });

  it("should never add a staff address of its own", async () => {
    await sendEmail({
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test",
      textBody: "Hello",
      messageStream: "broadcast",
      orgId: "test-org",
      userId: "test-user",
    });

    const message = mockSendEmail.mock.calls[0][0];
    expect(JSON.stringify(message)).not.toContain("distribute.you");
  });
});
