import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authorizeCredits } from "../../src/lib/billing-client";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("billing-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BILLING_SERVICE_URL = "http://billing:3012";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
  });

  afterEach(() => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });

  function mockAuthorizeResponse(sufficient: boolean, balance_cents: number, required_cents: number) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sufficient,
          balance_cents,
          required_cents,
        }),
    });
  }

  describe("authorizeCredits", () => {
    it("should return sufficient: true when billing approves", async () => {
      mockAuthorizeResponse(true, 100, 6);

      const result = await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "postmark-email-send", quantity: 3 }],
      });

      expect(result.sufficient).toBe(true);
      expect(result.balance_cents).toBe(100);
      expect(result.required_cents).toBe(6);

      // Verify billing authorize call with items
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("http://billing:3012/v1/credits/authorize");
      const body = JSON.parse(opts.body);
      expect(body.items).toEqual([{ costName: "postmark-email-send", quantity: 3 }]);
      expect(body.description).toBe("postmark-email-send × 3");
    });

    it("should return sufficient: false when billing denies", async () => {
      mockAuthorizeResponse(false, 2, 50);

      const result = await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "postmark-email-send", quantity: 10 }],
      });

      expect(result.sufficient).toBe(false);
      expect(result.balance_cents).toBe(2);
      expect(result.required_cents).toBe(50);
    });

    it("should forward tracking headers to billing-service", async () => {
      mockAuthorizeResponse(true, 50, 1);

      await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "postmark-email-send", quantity: 1 }],
        trackingHeaders: {
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-workflow-name": "wf-1",
        },
      });

      const billingHeaders = mockFetch.mock.calls[0][1].headers;
      expect(billingHeaders["x-campaign-id"]).toBe("camp-1");
      expect(billingHeaders["x-brand-id"]).toBe("brand-1");
      expect(billingHeaders["x-workflow-name"]).toBe("wf-1");
    });

    it("should throw when billing-service returns non-OK", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve("Payment provider error"),
      });

      await expect(
        authorizeCredits({
          orgId: "org-1",
          userId: "user-1",
          runId: "run-1",
          items: [{ costName: "postmark-email-send", quantity: 1 }],
        })
      ).rejects.toThrow("billing-service POST /v1/credits/authorize failed: 502");
    });

    it("should include identity headers", async () => {
      mockAuthorizeResponse(true, 100, 1);

      await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "postmark-email-send", quantity: 1 }],
      });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-1");
      expect(headers["x-run-id"]).toBe("run-1");
      expect(headers["X-API-Key"]).toBe("billing-key");
    });
  });
});
