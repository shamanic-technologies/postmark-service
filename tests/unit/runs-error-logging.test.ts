import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runs-client to simulate failures
vi.mock("../../src/lib/runs-client", () => ({
  ensureOrganization: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn(),
  addCosts: vi.fn(),
}));

// Mock postmark-client
vi.mock("../../src/lib/postmark-client", () => ({
  sendEmail: vi.fn(),
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

import { ensureOrganization, createRun } from "../../src/lib/runs-client";
import { sendEmail } from "../../src/lib/postmark-client";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

describe("runs-service error logging", () => {
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

  it("should log structured error with orgId, runId, and recipient on runs-service failure", async () => {
    vi.mocked(ensureOrganization).mockRejectedValue(
      new Error("runs-service POST /v1/organizations failed: 500 - Internal server error")
    );

    await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        orgId: "org_abc",
        runId: "run_xyz",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[runs-service]")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("orgId=org_abc")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("runId=run_xyz")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("to=recipient@test.com")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Email was delivered successfully")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Check RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY")
    );
  });

  it("should log structured error when createRun fails", async () => {
    vi.mocked(ensureOrganization).mockResolvedValue("runs-org-id");
    vi.mocked(createRun).mockRejectedValue(
      new Error("runs-service POST /v1/runs failed: 500 - Internal server error")
    );

    await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        orgId: "org_abc",
        runId: "run_xyz",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[runs-service]")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("runs-service POST /v1/runs failed: 500")
    );
  });

  it("should still return 200 when runs-service fails", async () => {
    vi.mocked(ensureOrganization).mockRejectedValue(
      new Error("runs-service unreachable")
    );

    const res = await request(app)
      .post("/send")
      .set(getAuthHeaders())
      .send({
        orgId: "org_abc",
        runId: "run_xyz",
        from: "sender@test.com",
        to: "recipient@test.com",
        subject: "Test",
        textBody: "Hello",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
