import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runs-client
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock postmark-client
vi.mock("../../src/lib/postmark-client", () => ({
  sendEmail: vi.fn().mockResolvedValue({
    success: true,
    messageId: "msg-123",
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  }),
}));

// Mock key-client
vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn(),
  getStreamId: vi.fn().mockResolvedValue("broadcast"),
  getFromAddress: vi.fn().mockResolvedValue("noreply@example.com"),
}));

// Mock billing-client
vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn(),
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

import { getOrgKey } from "../../src/lib/key-client";
import { authorizeCredits } from "../../src/lib/billing-client";
import { sendEmail } from "../../src/lib/postmark-client";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

describe("billing credit authorization gate", () => {
  const app = createTestApp();
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const validBody = {
    to: "user@example.com",
    subject: "Test",
    htmlBody: "<p>Hi</p>",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockClear();
  });

  describe("POST /send", () => {
    it("should return 402 when platform key and insufficient credits", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockResolvedValue({
        sufficient: false,
        balance_cents: 0,
        required_cents: 1,
      });

      const res = await request(app)
        .post("/send")
        .set(getAuthHeaders())
        .send(validBody);

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(res.body.balance_cents).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("should proceed when platform key and sufficient credits", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockResolvedValue({
        sufficient: true,
        balance_cents: 500,
        required_cents: 1,
      });

      const res = await request(app)
        .post("/send")
        .set(getAuthHeaders())
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sendEmail).toHaveBeenCalled();
      expect(authorizeCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ costName: "postmark-email-send", quantity: 1 }],
        })
      );
    });

    it("should skip authorization for BYOK (org) keys", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "org-token",
        keySource: "org",
      });

      const res = await request(app)
        .post("/send")
        .set(getAuthHeaders())
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(authorizeCredits).not.toHaveBeenCalled();
    });

    it("should return 500 when billing-service is unreachable", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockRejectedValue(
        new Error("billing-service POST /v1/credits/authorize failed: 502 - Bad Gateway")
      );

      const res = await request(app)
        .post("/send")
        .set(getAuthHeaders())
        .send(validBody);

      expect(res.status).toBe(500);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("should forward tracking headers to authorizeCredits", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockResolvedValue({
        sufficient: true,
        balance_cents: 100,
        required_cents: 1,
      });

      await request(app)
        .post("/send")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-workflow-name": "wf-1",
        })
        .send(validBody);

      expect(authorizeCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          trackingHeaders: expect.objectContaining({
            "x-campaign-id": "camp-1",
            "x-brand-id": "brand-1",
            "x-workflow-name": "wf-1",
          }),
        })
      );
    });
  });

  describe("POST /send/batch", () => {
    const batchBody = {
      emails: [
        { to: "a@example.com", subject: "A", htmlBody: "<p>A</p>" },
        { to: "b@example.com", subject: "B", htmlBody: "<p>B</p>" },
        { to: "c@example.com", subject: "C", htmlBody: "<p>C</p>" },
      ],
    };

    it("should return 402 when platform key and insufficient credits for batch", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockResolvedValue({
        sufficient: false,
        balance_cents: 1,
        required_cents: 3,
      });

      const res = await request(app)
        .post("/send/batch")
        .set(getAuthHeaders())
        .send(batchBody);

      expect(res.status).toBe(402);
      expect(res.body.error).toBe("Insufficient credits");
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("should authorize with total email count for batch", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "platform-token",
        keySource: "platform",
      });
      vi.mocked(authorizeCredits).mockResolvedValue({
        sufficient: true,
        balance_cents: 500,
        required_cents: 1,
      });

      const res = await request(app)
        .post("/send/batch")
        .set(getAuthHeaders())
        .send(batchBody);

      expect(res.status).toBe(200);
      expect(authorizeCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [{ costName: "postmark-email-send", quantity: 3 }],
        })
      );
    });

    it("should skip authorization for BYOK (org) keys in batch", async () => {
      vi.mocked(getOrgKey).mockResolvedValue({
        provider: "postmark",
        key: "org-token",
        keySource: "org",
      });

      const res = await request(app)
        .post("/send/batch")
        .set(getAuthHeaders())
        .send(batchBody);

      expect(res.status).toBe(200);
      expect(authorizeCredits).not.toHaveBeenCalled();
    });
  });
});
