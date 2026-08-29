import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "org-run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
  createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-1" }),
  updatePlatformRun: vi.fn().mockResolvedValue({}),
  addPlatformCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

import {
  createRun,
  updateRun,
  addCosts,
  createPlatformRun,
  updatePlatformRun,
  addPlatformCosts,
} from "../../src/lib/runs-client";
import { openSendLedger } from "../../src/lib/send-ledger";

const base = {
  orgId: "org-1",
  userId: "user-1",
  parentRunId: "parent-run-1",
  brandId: "brand-1",
  campaignId: "campaign-1",
  featureSlug: "feature-1",
  workflowSlug: "workflow-1",
  audienceId: "audience-1",
  trackingHeaders: { "x-feature-slug": "feature-1" },
};

describe("openSendLedger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("org payer", () => {
    it("opens the org's run, carrying the full attribution", async () => {
      const ledger = await openSendLedger({ ...base, payer: "org" });

      expect(ledger.runId).toBe("org-run-1");
      expect(createRun).toHaveBeenCalledWith(
        {
          orgId: "org-1",
          serviceName: "postmark-service",
          taskName: "email-send",
          parentRunId: "parent-run-1",
          userId: "user-1",
          brandId: "brand-1",
          campaignId: "campaign-1",
          featureSlug: "feature-1",
          workflowSlug: "workflow-1",
          audienceId: "audience-1",
        },
        base.trackingHeaders
      );
      expect(createPlatformRun).not.toHaveBeenCalled();
    });

    it("declares the cost against the org", async () => {
      const ledger = await openSendLedger({ ...base, payer: "org" });
      await ledger.addSendCost("platform");

      expect(addCosts).toHaveBeenCalledWith(
        "org-run-1",
        [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
        "org-1",
        "user-1",
        base.trackingHeaders
      );
      expect(addPlatformCosts).not.toHaveBeenCalled();
    });

    it("closes the org run on both outcomes", async () => {
      const ledger = await openSendLedger({ ...base, payer: "org" });
      await ledger.complete();
      await ledger.fail("boom");

      expect(updateRun).toHaveBeenNthCalledWith(
        1, "org-run-1", "completed", "org-1", "user-1", undefined, base.trackingHeaders
      );
      expect(updateRun).toHaveBeenNthCalledWith(
        2, "org-run-1", "failed", "org-1", "user-1", "boom", base.trackingHeaders
      );
      expect(updatePlatformRun).not.toHaveBeenCalled();
    });
  });

  describe("platform payer", () => {
    // The org must not appear anywhere on this run: runs-service stores it and
    // then sums the cost into that org's usage total, which is the billing this
    // path exists to remove.
    it("opens an org-less platform run", async () => {
      const ledger = await openSendLedger({ ...base, payer: "platform" });

      expect(ledger.runId).toBe("platform-run-1");
      expect(createPlatformRun).toHaveBeenCalledWith(
        { serviceName: "postmark-service", taskName: "email-send" },
        base.trackingHeaders
      );
      expect(createRun).not.toHaveBeenCalled();

      const [body] = vi.mocked(createPlatformRun).mock.calls[0];
      expect(body).not.toHaveProperty("orgId");
      expect(body).not.toHaveProperty("userId");
      expect(body).not.toHaveProperty("parentRunId");
    });

    it("declares the same cost, on the platform run", async () => {
      const ledger = await openSendLedger({ ...base, payer: "platform" });
      await ledger.addSendCost("platform");

      expect(addPlatformCosts).toHaveBeenCalledWith(
        "platform-run-1",
        [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
        base.trackingHeaders
      );
      expect(addCosts).not.toHaveBeenCalled();
    });

    it("passes the key's own source through as costSource", async () => {
      const ledger = await openSendLedger({ ...base, payer: "platform" });
      await ledger.addSendCost("org");

      // costSource says which Postmark key paid the vendor, not who is billed.
      expect(addPlatformCosts).toHaveBeenCalledWith(
        "platform-run-1",
        [{ costName: "postmark-email-send", quantity: 1, costSource: "org" }],
        base.trackingHeaders
      );
    });

    it("closes the platform run on both outcomes", async () => {
      const ledger = await openSendLedger({ ...base, payer: "platform" });
      await ledger.complete();
      await ledger.fail("boom");

      expect(updatePlatformRun).toHaveBeenNthCalledWith(
        1, "platform-run-1", "completed", undefined, base.trackingHeaders
      );
      expect(updatePlatformRun).toHaveBeenNthCalledWith(
        2, "platform-run-1", "failed", "boom", base.trackingHeaders
      );
      expect(updateRun).not.toHaveBeenCalled();
    });
  });

  it("fails loud when the run cannot be opened", async () => {
    vi.mocked(createPlatformRun).mockRejectedValueOnce(new Error("runs-service down"));
    await expect(
      openSendLedger({ ...base, payer: "platform" })
    ).rejects.toThrow("runs-service down");

    vi.mocked(createRun).mockRejectedValueOnce(new Error("runs-service down"));
    await expect(
      openSendLedger({ ...base, payer: "org" })
    ).rejects.toThrow("runs-service down");
  });
});
