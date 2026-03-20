import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authorizeCredits, _clearCostCache } from "../../src/lib/billing-client";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("billing-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearCostCache();
    process.env.BILLING_SERVICE_URL = "http://billing:3012";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    process.env.COSTS_SERVICE_URL = "http://costs:3011";
    process.env.COSTS_SERVICE_API_KEY = "costs-key";
  });

  afterEach(() => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    delete process.env.COSTS_SERVICE_URL;
    delete process.env.COSTS_SERVICE_API_KEY;
  });

  function mockCostsResponse(pricePerUnitInUsdCents: string) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "postmark-email-send",
          pricePerUnitInUsdCents,
          provider: "postmark",
          effectiveFrom: "2025-01-01T00:00:00Z",
        }),
    });
  }

  function mockAuthorizeResponse(sufficient: boolean, balance_cents: number) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sufficient,
          balance_cents,
          billing_mode: "payg",
        }),
    });
  }

  describe("authorizeCredits", () => {
    it("should return sufficient: true when billing approves", async () => {
      mockCostsResponse("2");
      mockAuthorizeResponse(true, 100);

      const result = await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 3,
      });

      expect(result.sufficient).toBe(true);
      expect(result.balance_cents).toBe(100);

      // Verify costs-service call
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://costs:3011/v1/platform-prices/postmark-email-send",
        expect.objectContaining({ method: "GET" })
      );

      // Verify billing authorize call with correct cost (2 cents × 3 emails = 6)
      const billingCall = mockFetch.mock.calls[1];
      expect(billingCall[0]).toBe("http://billing:3012/v1/credits/authorize");
      const body = JSON.parse(billingCall[1].body);
      expect(body.required_cents).toBe(6);
      expect(body.description).toBe("postmark-email-send × 3");
    });

    it("should return sufficient: false when billing denies", async () => {
      mockCostsResponse("5");
      mockAuthorizeResponse(false, 2);

      const result = await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 10,
      });

      expect(result.sufficient).toBe(false);
      expect(result.balance_cents).toBe(2);
    });

    it("should forward tracking headers to both services", async () => {
      mockCostsResponse("1");
      mockAuthorizeResponse(true, 50);

      await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 1,
        trackingHeaders: {
          "x-campaign-id": "camp-1",
          "x-brand-id": "brand-1",
          "x-workflow-name": "wf-1",
        },
      });

      // Check tracking headers on costs call
      const costsHeaders = mockFetch.mock.calls[0][1].headers;
      expect(costsHeaders["x-campaign-id"]).toBe("camp-1");
      expect(costsHeaders["x-brand-id"]).toBe("brand-1");
      expect(costsHeaders["x-workflow-name"]).toBe("wf-1");

      // Check tracking headers on billing call
      const billingHeaders = mockFetch.mock.calls[1][1].headers;
      expect(billingHeaders["x-campaign-id"]).toBe("camp-1");
      expect(billingHeaders["x-brand-id"]).toBe("brand-1");
      expect(billingHeaders["x-workflow-name"]).toBe("wf-1");
    });

    it("should use fallback cost when costs-service is unreachable", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("error") });
      mockAuthorizeResponse(true, 100);

      const result = await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 5,
      });

      expect(result.sufficient).toBe(true);

      // Should use fallback of 1 cent × 5 = 5
      const billingBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(billingBody.required_cents).toBe(5);
    });

    it("should cache unit cost across calls", async () => {
      mockCostsResponse("3");
      mockAuthorizeResponse(true, 100);

      await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 1,
      });

      // Second call should not hit costs-service again
      mockAuthorizeResponse(true, 97);
      await authorizeCredits({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        emailCount: 1,
      });

      // costs-service called once, billing called twice
      const costsCalls = mockFetch.mock.calls.filter((c) =>
        c[0].includes("costs")
      );
      const billingCalls = mockFetch.mock.calls.filter((c) =>
        c[0].includes("billing")
      );
      expect(costsCalls).toHaveLength(1);
      expect(billingCalls).toHaveLength(2);
    });

    it("should throw when billing-service returns non-OK", async () => {
      mockCostsResponse("1");
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
          emailCount: 1,
        })
      ).rejects.toThrow("billing-service POST /v1/credits/authorize failed: 502");
    });
  });
});
