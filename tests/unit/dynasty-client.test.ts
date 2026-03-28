import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchAllFeatureDynasties,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
} from "../../src/lib/dynasty-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const headers = { orgId: "org-1", userId: "user-1", runId: "run-1" };

describe("dynasty-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("resolveFeatureDynastySlugs", () => {
    it("should call features-service and return slugs", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ slugs: ["feat-a", "feat-a-v2", "feat-a-v3"] }),
      });

      const slugs = await resolveFeatureDynastySlugs("feat-a", headers);

      expect(slugs).toEqual(["feat-a", "feat-a-v2", "feat-a-v3"]);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/features/dynasty/slugs?dynastySlug=feat-a");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["x-user-id"]).toBe("user-1");
      expect(opts.headers["x-run-id"]).toBe("run-1");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });

      await expect(
        resolveFeatureDynastySlugs("nonexistent", headers),
      ).rejects.toThrow("features-service GET /features/dynasty/slugs failed: 404");
    });

    it("should URL-encode the dynasty slug", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ slugs: [] }),
      });

      await resolveFeatureDynastySlugs("slug with spaces", headers);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("dynastySlug=slug%20with%20spaces");
    });
  });

  describe("resolveWorkflowDynastySlugs", () => {
    it("should call workflow-service and return slugs", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ slugs: ["cold-email", "cold-email-v2"] }),
      });

      const slugs = await resolveWorkflowDynastySlugs("cold-email", headers);

      expect(slugs).toEqual(["cold-email", "cold-email-v2"]);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/workflows/dynasty/slugs?dynastySlug=cold-email");
      expect(opts.headers["x-org-id"]).toBe("org-1");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal error",
      });

      await expect(
        resolveWorkflowDynastySlugs("bad", headers),
      ).rejects.toThrow("workflow-service GET /workflows/dynasty/slugs failed: 500");
    });
  });

  describe("fetchAllFeatureDynasties", () => {
    it("should call features-service /features/dynasties and return dynasties", async () => {
      const dynasties = [
        { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
      ];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ dynasties }),
      });

      const result = await fetchAllFeatureDynasties(headers);

      expect(result).toEqual(dynasties);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/features/dynasties");
      expect(opts.headers["x-org-id"]).toBe("org-1");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Server error",
      });

      await expect(fetchAllFeatureDynasties(headers)).rejects.toThrow(
        "features-service GET /features/dynasties failed: 500",
      );
    });
  });

  describe("fetchAllWorkflowDynasties", () => {
    it("should call workflow-service /workflows/dynasties and return dynasties", async () => {
      const dynasties = [
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      ];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ dynasties }),
      });

      const result = await fetchAllWorkflowDynasties(headers);

      expect(result).toEqual(dynasties);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/workflows/dynasties");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });

      await expect(fetchAllWorkflowDynasties(headers)).rejects.toThrow(
        "workflow-service GET /workflows/dynasties failed: 404",
      );
    });
  });

  describe("buildSlugToDynastyMap", () => {
    it("should build a reverse map from dynasties", () => {
      const dynasties = [
        { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] },
        { dynastySlug: "warm-intro", slugs: ["warm-intro"] },
      ];

      const map = buildSlugToDynastyMap(dynasties);

      expect(map.get("cold-email")).toBe("cold-email");
      expect(map.get("cold-email-v2")).toBe("cold-email");
      expect(map.get("cold-email-v3")).toBe("cold-email");
      expect(map.get("warm-intro")).toBe("warm-intro");
      expect(map.size).toBe(4);
    });

    it("should return empty map for empty dynasties", () => {
      const map = buildSlugToDynastyMap([]);
      expect(map.size).toBe(0);
    });
  });
});
