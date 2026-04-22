import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runs-client
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
  getFromAddress: vi.fn().mockResolvedValue("default@test.com"),
}));

// Mock billing-client
vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({
    sufficient: true,
    balance_cents: 1000,
    billing_mode: "payg",
  }),
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

import { createRun, updateRun, addCosts } from "../../src/lib/runs-client";
import { sendEmail } from "../../src/lib/postmark-client";
import { getOrgKey, getStreamId, getFromAddress } from "../../src/lib/key-client";
import { db } from "../../src/db";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

const mockRun = {
  id: "run-1",
  parentRunId: "test-run-id",
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
};

describe("workflow tracking headers (x-campaign-id, x-brand-id, x-feature-slug, x-workflow-slug)", () => {
  const app = createTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createRun).mockResolvedValue(mockRun);
    vi.mocked(updateRun).mockResolvedValue({ ...mockRun, status: "completed" });
    vi.mocked(addCosts).mockResolvedValue({ costs: [] });
    vi.mocked(sendEmail).mockResolvedValue({
      success: true,
      messageId: "msg-123",
      submittedAt: new Date(),
      errorCode: 0,
      message: "OK",
    });
  });

  describe("POST /send", () => {
    it("should use tracking headers when body fields are absent", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-from-header",
          "x-brand-id": "brand-from-header",
          "x-feature-slug": "feat-from-header",
          "x-workflow-slug": "wf-from-header",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      // createRun should receive values from headers
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp-from-header",
          brandId: "brand-from-header",
          featureSlug: "feat-from-header",
          workflowSlug: "wf-from-header",
        }),
        expect.objectContaining({
          "x-campaign-id": "camp-from-header",
          "x-brand-id": "brand-from-header",
          "x-feature-slug": "feat-from-header",
          "x-workflow-slug": "wf-from-header",
        })
      );

      // DB insert should have the header values
      expect(db.insert).toHaveBeenCalled();
      const insertCall = vi.mocked(db.insert).mock.results[0].value;
      const valuesCall = insertCall.values.mock.calls[0][0];
      expect(valuesCall.campaignId).toBe("camp-from-header");
      expect(valuesCall.brandIds).toEqual(["brand-from-header"]);
      expect(valuesCall.featureSlug).toBe("feat-from-header");
      expect(valuesCall.workflowSlug).toBe("wf-from-header");
    });

    it("should prefer body values over header values", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-from-header",
          "x-brand-id": "brand-from-header",
          "x-feature-slug": "feat-from-header",
          "x-workflow-slug": "wf-from-header",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
          campaignId: "camp-from-body",
          brandId: ["brand-from-body"],
          featureSlug: "feat-from-body",
          workflowSlug: "wf-from-body",
        });

      // createRun should receive body values (not header values)
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: "camp-from-body",
          brandId: "brand-from-body",
          featureSlug: "feat-from-body",
          workflowSlug: "wf-from-body",
        }),
        expect.any(Object)
      );

      // DB insert should have body values
      const insertCall = vi.mocked(db.insert).mock.results[0].value;
      const valuesCall = insertCall.values.mock.calls[0][0];
      expect(valuesCall.campaignId).toBe("camp-from-body");
      expect(valuesCall.brandIds).toEqual(["brand-from-body"]);
      expect(valuesCall.featureSlug).toBe("feat-from-body");
      expect(valuesCall.workflowSlug).toBe("wf-from-body");
    });

    it("should parse CSV x-brand-id header into brandIds DB array", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-brand-id": "brand-a,brand-b,brand-c",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      // DB insert should store as array
      const insertCall = vi.mocked(db.insert).mock.results[0].value;
      const valuesCall = insertCall.values.mock.calls[0][0];
      expect(valuesCall.brandIds).toEqual(["brand-a", "brand-b", "brand-c"]);

      // createRun gets the first brand ID (backwards compatible with runs-service)
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({ brandId: "brand-a" }),
        expect.objectContaining({ "x-brand-id": "brand-a,brand-b,brand-c" })
      );
    });

    it("should handle single brand in x-brand-id header (backwards compatible)", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-brand-id": "single-brand",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      const insertCall = vi.mocked(db.insert).mock.results[0].value;
      const valuesCall = insertCall.values.mock.calls[0][0];
      expect(valuesCall.brandIds).toEqual(["single-brand"]);
    });

    it("should work without any tracking headers or body fields", async () => {
      const res = await request(app)
        .post("/orgs/send")
        .set(getAuthHeaders())
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      expect(res.status).toBe(200);
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignId: undefined,
          brandId: undefined,
          featureSlug: undefined,
          workflowSlug: undefined,
        }),
        {} // empty tracking headers
      );
    });

    it("should forward tracking headers to runs-service (updateRun, addCosts)", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-feature-slug": "feat-1",
          "x-workflow-slug": "wf-1",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      const expectedTracking = {
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1",
        "x-feature-slug": "feat-1",
        "x-workflow-slug": "wf-1",
      };

      expect(addCosts).toHaveBeenCalledWith(
        "run-1",
        expect.any(Array),
        "test-org-id",
        "test-user-id",
        expectedTracking
      );
      expect(updateRun).toHaveBeenCalledWith(
        "run-1",
        "completed",
        "test-org-id",
        "test-user-id",
        undefined,
        expectedTracking
      );
    });

    it("should forward tracking headers to key-service", async () => {
      await request(app)
        .post("/orgs/send")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-feature-slug": "feat-1",
          "x-workflow-slug": "wf-1",
        })
        .send({
          to: "recipient@test.com",
          subject: "Test",
          textBody: "Hello",
        });

      const expectedTracking = {
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1",
        "x-feature-slug": "feat-1",
        "x-workflow-slug": "wf-1",
      };

      expect(getOrgKey).toHaveBeenCalledWith(
        "test-org-id",
        "test-user-id",
        "postmark",
        expect.any(Object),
        expectedTracking
      );
      expect(getStreamId).toHaveBeenCalledWith(
        "test-org-id",
        "test-user-id",
        "broadcast",
        expect.any(Object),
        expectedTracking
      );
    });
  });

  describe("POST /send/batch", () => {
    it("should use tracking headers as fallback for batch emails", async () => {
      await request(app)
        .post("/orgs/send/batch")
        .set({
          ...getAuthHeaders(),
          "x-campaign-id": "camp-from-header",
          "x-brand-id": "brand-from-header",
          "x-feature-slug": "feat-from-header",
          "x-workflow-slug": "wf-from-header",
        })
        .send({
          emails: [
            {
              to: "a@test.com",
              subject: "Test A",
              textBody: "Hello A",
              // no body-level tracking fields — should use headers
            },
            {
              to: "b@test.com",
              subject: "Test B",
              textBody: "Hello B",
              campaignId: "camp-from-body", // body overrides header
            },
          ],
        });

      // First email: header values
      expect(createRun).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          campaignId: "camp-from-header",
          brandId: "brand-from-header",
          featureSlug: "feat-from-header",
          workflowSlug: "wf-from-header",
        }),
        expect.any(Object)
      );

      // Second email: body campaignId overrides header, rest from header
      expect(createRun).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          campaignId: "camp-from-body",
          brandId: "brand-from-header",
          workflowSlug: "wf-from-header",
        }),
        expect.any(Object)
      );
    });
  });
});
