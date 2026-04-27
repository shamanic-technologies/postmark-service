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
  fetchAllFeatureDynasties: vi.fn(),
  fetchAllWorkflowDynasties: vi.fn(),
  buildSlugToDynastyMap: vi.fn(),
}));

import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchAllFeatureDynasties,
  fetchAllWorkflowDynasties,
  buildSlugToDynastyMap,
} from "../../src/lib/dynasty-client";

const mockResolveFeature = vi.mocked(resolveFeatureDynastySlugs);
const mockResolveWorkflow = vi.mocked(resolveWorkflowDynastySlugs);
const mockFetchAllFeatureDynasties = vi.mocked(fetchAllFeatureDynasties);
const mockFetchAllWorkflowDynasties = vi.mocked(fetchAllWorkflowDynasties);
const mockBuildSlugToDynastyMap = vi.mocked(buildSlugToDynastyMap);

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

  // ─── featureSlugs filter ──────────────────────────────────────────────────

  it("should filter by featureSlugs", async () => {
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-beta" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ featureSlugs: "feat-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
  });

  it("should group by featureSlug", async () => {
    const org = "org-group-feat";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-1" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-1" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "featureSlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const feat1 = response.body.groups.find((g: any) => g.key === "feat-1");
    const feat2 = response.body.groups.find((g: any) => g.key === "feat-2");
    expect(feat1.recipientStats.sent).toBe(2);
    expect(feat2.recipientStats.sent).toBe(1);
  });

  // ─── featureDynastySlug filter ───────────────────────────────────────────

  it("should resolve featureDynastySlug and filter with IN clause", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "b1", campaignId: "c1", featureSlug: "feat-beta" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
    expect(mockResolveFeature).toHaveBeenCalledWith("feat-alpha", expect.any(Object));
  });

  it("should return empty stats when featureDynastySlug resolves to empty list", async () => {
    mockResolveFeature.mockResolvedValue([]);

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "nonexistent-dynasty" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(0);
  });

  it("should combine featureDynastySlug with other filters", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "brand-x", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "brand-y", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "brand-x", campaignId: "c1", featureSlug: "feat-alpha-v2" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha", brandId: "brand-x" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
  });

  // ─── workflowDynastySlug filter ──────────────────────────────────────────

  it("should resolve workflowDynastySlug and filter with IN clause", async () => {
    mockResolveWorkflow.mockResolvedValue(["cold-email-sequoia", "cold-email-sequoia-v2"]);

    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "cold-email-sequoia" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "cold-email-sequoia-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "other-wf" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "cold-email-sequoia" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(2);
    expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email-sequoia", expect.any(Object));
  });

  it("should return empty stats when workflowDynastySlug resolves to empty list", async () => {
    mockResolveWorkflow.mockResolvedValue([]);

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "nonexistent-dynasty" });

    expect(response.status).toBe(200);
    expect(response.body.recipientStats.sent).toBe(0);
  });

  it("should support grouped response with dynasty slug filters", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);

    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "brand-a", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "brand-b", campaignId: "c1", featureSlug: "feat-alpha-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "brand-a", campaignId: "c1", featureSlug: "feat-beta" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ featureDynastySlug: "feat-alpha", groupBy: "brandId" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const brandA = response.body.groups.find((g: any) => g.key === "brand-a");
    const brandB = response.body.groups.find((g: any) => g.key === "brand-b");
    expect(brandA.recipientStats.sent).toBe(1);
    expect(brandB.recipientStats.sent).toBe(1);
  });

  // ─── workflowDynastySlug merges with workflowSlugs ──────────────────────

  it("should merge dynasty slugs with workflowSlugs when both provided", async () => {
    mockResolveWorkflow.mockResolvedValue(["wf-a", "wf-a-v2"]);

    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-a" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-a-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", brandId: "b1", campaignId: "c1", workflowSlug: "wf-other" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ workflowDynastySlug: "wf-a", workflowSlugs: "wf-other" });

    expect(response.status).toBe(200);
    // Dynasty resolves to wf-a + wf-a-v2, merged with wf-other from query
    expect(response.body.recipientStats.sent).toBe(3);
  });

  // ─── groupBy workflowDynastySlug ──────────────────────────────────────────

  it("should group by workflowDynastySlug using reverse map", async () => {
    // buildSlugToDynastyMap is a pure function — mock it to return a real map
    mockFetchAllWorkflowDynasties.mockResolvedValue([
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2"] },
    ]);
    mockBuildSlugToDynastyMap.mockReturnValue(
      new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
        ["warm-intro", "warm-intro"],
        ["warm-intro-v2", "warm-intro"],
      ]),
    );

    const org = "org-dynasty-group";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "cold-email" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "cold-email-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "warm-intro" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "workflowDynastySlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const coldEmail = response.body.groups.find((g: any) => g.key === "cold-email");
    const warmIntro = response.body.groups.find((g: any) => g.key === "warm-intro");
    expect(coldEmail.recipientStats.sent).toBe(2);
    expect(warmIntro.recipientStats.sent).toBe(1);

    expect(mockFetchAllWorkflowDynasties).toHaveBeenCalledOnce();
    expect(mockBuildSlugToDynastyMap).toHaveBeenCalledOnce();
  });

  // ─── groupBy featureDynastySlug ───────────────────────────────────────────

  it("should group by featureDynastySlug using reverse map", async () => {
    mockFetchAllFeatureDynasties.mockResolvedValue([
      { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
      { dynastySlug: "feat-beta", slugs: ["feat-beta"] },
    ]);
    mockBuildSlugToDynastyMap.mockReturnValue(
      new Map([
        ["feat-alpha", "feat-alpha"],
        ["feat-alpha-v2", "feat-alpha"],
        ["feat-beta", "feat-beta"],
      ]),
    );

    const org = "org-feat-dynasty-group";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-alpha-v2" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "c@test.com", orgId: org, brandId: "b1", campaignId: "c1", featureSlug: "feat-beta" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "featureDynastySlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const alpha = response.body.groups.find((g: any) => g.key === "feat-alpha");
    const beta = response.body.groups.find((g: any) => g.key === "feat-beta");
    expect(alpha.recipientStats.sent).toBe(2);
    expect(beta.recipientStats.sent).toBe(1);

    expect(mockFetchAllFeatureDynasties).toHaveBeenCalledOnce();
  });

  it("should fall back to raw slug when slug not in dynasty map", async () => {
    mockFetchAllWorkflowDynasties.mockResolvedValue([
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
    ]);
    mockBuildSlugToDynastyMap.mockReturnValue(
      new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
      ]),
    );

    const org = "org-orphan-slug";
    await insertTestSending({ messageId: randomUUID(), toEmail: "a@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "cold-email" });
    await insertTestSending({ messageId: randomUUID(), toEmail: "b@test.com", orgId: org, brandId: "b1", campaignId: "c1", workflowSlug: "orphan-wf" });

    const response = await request(app)
      .get("/orgs/stats")
      .set(getAuthHeaders())
      .query({ orgId: org, groupBy: "workflowDynastySlug" });

    expect(response.status).toBe(200);
    expect(response.body.groups).toHaveLength(2);

    const coldEmail = response.body.groups.find((g: any) => g.key === "cold-email");
    const orphan = response.body.groups.find((g: any) => g.key === "orphan-wf");
    expect(coldEmail.recipientStats.sent).toBe(1);
    expect(orphan.recipientStats.sent).toBe(1);
  });
});
