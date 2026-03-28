import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  randomUUID,
} from "../helpers/test-db";

// Mock dynasty-client to avoid calling real external services
vi.mock("../../src/lib/dynasty-client", () => ({
  resolveFeatureDynastySlugs: vi.fn(),
  resolveWorkflowDynastySlugs: vi.fn(),
}));

import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
} from "../../src/lib/dynasty-client";

const mockResolveFeature = vi.mocked(resolveFeatureDynastySlugs);
const mockResolveWorkflow = vi.mocked(resolveWorkflowDynastySlugs);

describe("GET /stats — featureSlug and dynasty slug filters", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // ─── featureSlug filter ──────────────────────────────────────────────────

  it("should filter by featureSlug", async () => {
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-beta" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ featureSlug: "feat-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
  });

  it("should group by featureSlug", async () => {
    const org = "org-group-feat";
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-1" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-2" });
    await insertTestSending({ messageId: randomUUID(), orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-1" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "featureSlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const feat1 = response.body.groups.find((g: any) => g.key === "feat-1");
    const feat2 = response.body.groups.find((g: any) => g.key === "feat-2");
    expect(feat1.stats.emailsSent).toBe(2);
    expect(feat2.stats.emailsSent).toBe(1);
  });

  // ─── featureDynastySlug filter ───────────────────────────────────────────

  it("should resolve featureDynastySlug and filter with IN clause", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha-v2" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", featureSlug: "feat-beta" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
    expect(mockResolveFeature).toHaveBeenCalledWith("feat-alpha", expect.any(Object));
  });

  it("should return empty stats when featureDynastySlug resolves to empty list", async () => {
    mockResolveFeature.mockResolvedValue([]);

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "nonexistent-dynasty" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(0);
  });

  it("should combine featureDynastySlug with other filters", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), brandId: "brand-x", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-y", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-x", campaignId: "c1", featureSlug: "feat-alpha-v2" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha", brandId: "brand-x" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
  });

  // ─── workflowDynastySlug filter ──────────────────────────────────────────

  it("should resolve workflowDynastySlug and filter with IN clause", async () => {
    mockResolveWorkflow.mockResolvedValue(["cold-email-sequoia", "cold-email-sequoia-v2"]);

    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "cold-email-sequoia" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "cold-email-sequoia-v2" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "other-wf" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "cold-email-sequoia" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(2);
    expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email-sequoia", expect.any(Object));
  });

  it("should return empty stats when workflowDynastySlug resolves to empty list", async () => {
    mockResolveWorkflow.mockResolvedValue([]);

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "nonexistent-dynasty" });

    expect(response.status).toBe(200);
    expect(response.body.stats.emailsSent).toBe(0);
  });

  it("should support grouped response with dynasty slug filters", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), brandId: "brand-a", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-b", campaignId: "c1", featureSlug: "feat-alpha-v2" });
    await insertTestSending({ messageId: randomUUID(), brandId: "brand-a", campaignId: "c1", featureSlug: "feat-beta" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha", groupBy: "brandId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const brandA = response.body.groups.find((g: any) => g.key === "brand-a");
    const brandB = response.body.groups.find((g: any) => g.key === "brand-b");
    expect(brandA.stats.emailsSent).toBe(1);
    expect(brandB.stats.emailsSent).toBe(1);
  });

  // ─── workflowDynastySlug overrides workflowSlug ──────────────────────────

  it("should use dynasty slugs over single workflowSlug when both provided", async () => {
    mockResolveWorkflow.mockResolvedValue(["wf-a", "wf-a-v2"]);

    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "wf-a" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "wf-a-v2" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1", workflowSlug: "wf-other" });

    const response = await request(app)
      .get("/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "wf-a", workflowSlug: "wf-other" });

    expect(response.status).toBe(200);
    // Dynasty takes precedence — resolves to wf-a + wf-a-v2
    expect(response.body.stats.emailsSent).toBe(2);
  });
});
