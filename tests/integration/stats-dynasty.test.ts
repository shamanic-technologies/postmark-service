import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  randomUUID,
} from "../helpers/test-db";

describe("GET /stats — featureSlug filters", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
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
});
