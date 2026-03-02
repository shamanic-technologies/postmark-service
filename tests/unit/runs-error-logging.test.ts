import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runs-client to simulate failures
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  addCosts: vi.fn(),
}));

// Mock postmark-client
vi.mock("../../src/lib/postmark-client", () => ({
  sendEmail: vi.fn(),
}));

// Mock key-client
vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn().mockResolvedValue({
    provider: "postmark",
    key: "test-token",
    keySource: "platform",
  }),
  getStreamId: vi.fn().mockResolvedValue("broadcast"),
}));

// Mock database
vi.mock("../../src/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "sending-1" }]),
      })),
    })),
  },
}));

import { createRun } from "../../src/lib/runs-client";
import { sendEmail } from "../../src/lib/postmark-client";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

describe("runs-service BLOCKING behavior", () => {
  const app = createTestApp();
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    consoleSpy.mockClear();
    vi.mocked(sendEmail).mockResolvedValue({
      success: true,
      messageId: "msg-123",
      submittedAt: new Date(),
      errorCode: 0,
      message: "OK",
    });
  });

  it("should return 500 when createRun fails (BLOCKING)", async () => {
    vi.mocked(createRun).mockRejectedValue(
      new Error("runs-service POST /v1/runs failed: 500 - Internal server error")
    );

    const res = await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        parentRunId: "run_xyz",
        brandId: "brand_1",
        campaignId: "campaign_1",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    // BLOCKING: should return 500
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to send email");

    // Email should NOT have been sent
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("should pass orgId from header to createRun", async () => {
    vi.mocked(createRun).mockResolvedValue({
      id: "run-1",
      parentRunId: "run_xyz",
      organizationId: "org-internal",
      userId: null,
      brandId: "brand_1",
      campaignId: "campaign_1",
      serviceName: "postmark-service",
      taskName: "email-send",
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await request(app)
      .post("/send")
      .set(getAuthHeaders({ orgId: "org_abc", userId: "user_xyz" }))
      .send({
        parentRunId: "run_xyz",
        brandId: "brand_1",
        campaignId: "campaign_1",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(createRun).toHaveBeenCalledWith({
      orgId: "org_abc",
      serviceName: "postmark-service",
      taskName: "email-send",
      parentRunId: "run_xyz",
      userId: "user_xyz",
      brandId: "brand_1",
      campaignId: "campaign_1",
    });
  });

  it("should always create a run (orgId from header)", async () => {
    vi.mocked(createRun).mockResolvedValue({
      id: "run-1",
      parentRunId: null,
      organizationId: "org-internal",
      userId: null,
      brandId: null,
      campaignId: null,
      serviceName: "postmark-service",
      taskName: "email-send",
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "test-org-id" })
    );
  });

  it("should log error to console when runs-service fails", async () => {
    vi.mocked(createRun).mockRejectedValue(
      new Error("runs-service unreachable")
    );

    await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        parentRunId: "run_xyz",
        brandId: "brand_1",
        campaignId: "campaign_1",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[send] Failed to process email")
    );
  });
});
