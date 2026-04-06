import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getServiceHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  insertTestOpening,
  randomUUID,
} from "../helpers/test-db";

describe("GET /public/performance/leaderboard", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should return empty workflows when no sendings exist", async () => {
    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.workflows).toEqual([]);
  });

  it("should return global stats grouped by workflowSlug", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();

    await insertTestSending({ messageId: msg1, orgId: "org-1", workflowSlug: "Pharaoh", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg2, orgId: "org-1", workflowSlug: "Pharaoh", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg3, orgId: "org-2", workflowSlug: "Darmstadt", brandId: "b2", campaignId: "c2" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestOpening(msg1);

    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.workflows).toHaveLength(2);

    const pharaoh = response.body.workflows.find((w: any) => w.workflowSlug === "Pharaoh");
    const darmstadt = response.body.workflows.find((w: any) => w.workflowSlug === "Darmstadt");

    expect(pharaoh).toBeDefined();
    expect(pharaoh.emailsSent).toBe(2);
    expect(pharaoh.emailsDelivered).toBe(2);
    expect(pharaoh.emailsOpened).toBe(1);
    expect(pharaoh.openRate).toBe(0.5);

    expect(darmstadt).toBeDefined();
    expect(darmstadt.emailsSent).toBe(1);
    expect(darmstadt.emailsDelivered).toBe(0);
  });

  it("should exclude sendings with no workflowSlug", async () => {
    await insertTestSending({ messageId: randomUUID(), workflowSlug: "Pharaoh", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), brandId: "b1", campaignId: "c1" }); // no workflowSlug

    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.workflows).toHaveLength(1);
    expect(response.body.workflows[0].workflowSlug).toBe("Pharaoh");
  });

  it("should sort workflows by emailsSent descending", async () => {
    await insertTestSending({ messageId: randomUUID(), workflowSlug: "Small", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), workflowSlug: "Big", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), workflowSlug: "Big", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: randomUUID(), workflowSlug: "Big", brandId: "b1", campaignId: "c1" });

    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.workflows[0].workflowSlug).toBe("Big");
    expect(response.body.workflows[0].emailsSent).toBe(3);
    expect(response.body.workflows[1].workflowSlug).toBe("Small");
    expect(response.body.workflows[1].emailsSent).toBe(1);
  });

  it("should compute rates correctly", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();
    const msg4 = randomUUID();

    await insertTestSending({ messageId: msg1, workflowSlug: "Test", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg2, workflowSlug: "Test", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg3, workflowSlug: "Test", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg4, workflowSlug: "Test", brandId: "b1", campaignId: "c1" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestDelivery(msg3);
    await insertTestOpening(msg1);
    await insertTestOpening(msg2);
    await insertTestBounce(msg4);

    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    const wf = response.body.workflows[0];
    expect(wf.emailsSent).toBe(4);
    expect(wf.emailsDelivered).toBe(3);
    expect(wf.emailsOpened).toBe(2);
    expect(wf.emailsBounced).toBe(1);
    expect(wf.openRate).toBe(0.5);       // 2/4
    expect(wf.deliveryRate).toBe(0.75);   // 3/4
    expect(wf.bounceRate).toBe(0.25);     // 1/4
  });

  it("should aggregate across multiple orgs for the same workflow", async () => {
    const msg1 = randomUUID();
    const msg2 = randomUUID();
    const msg3 = randomUUID();

    await insertTestSending({ messageId: msg1, orgId: "org-X", workflowSlug: "Pharaoh", brandId: "b1", campaignId: "c1" });
    await insertTestSending({ messageId: msg2, orgId: "org-Y", workflowSlug: "Pharaoh", brandId: "b2", campaignId: "c2" });
    await insertTestSending({ messageId: msg3, orgId: "org-Z", workflowSlug: "Pharaoh", brandId: "b3", campaignId: "c3" });

    await insertTestDelivery(msg1);
    await insertTestDelivery(msg2);
    await insertTestDelivery(msg3);
    await insertTestOpening(msg1);
    await insertTestOpening(msg3);

    const response = await request(app)
      .get("/public/performance/leaderboard")
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.workflows).toHaveLength(1);

    const pharaoh = response.body.workflows[0];
    expect(pharaoh.emailsSent).toBe(3);
    expect(pharaoh.emailsDelivered).toBe(3);
    expect(pharaoh.emailsOpened).toBe(2);
  });
});
