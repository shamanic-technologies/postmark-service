import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, getServiceHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  randomUUID,
} from "../helpers/test-db";

/**
 * The per-operation read.
 *
 * The behaviour that matters most here is the one an all-zero response cannot
 * express: a tag nothing carries is reported as such, so a caller polling an
 * operation in flight can tell "my question found nothing" from "the outcomes
 * are zero". Every assertion about zeros below is really an assertion that we
 * never emit them without messages behind them.
 */
describe("GET /stats/by-tag", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("reports a tag nothing carries as unmatched, with no stats at all", async () => {
    const response = await request(app)
      .get("/internal/stats/by-tag")
      .set(getServiceHeaders())
      .query({ tag: "an-operation-that-never-ran" });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(false);
    expect(response.body.messageCount).toBe(0);
    expect(response.body.tag).toBe("an-operation-that-never-ran");
    expect(response.body).not.toHaveProperty("emailStats");
    expect(response.body).not.toHaveProperty("recipientStats");
  });

  it("aggregates exactly the messages carrying the tag", async () => {
    const tag = "mailing-list-release-abc";
    const mine = [randomUUID(), randomUUID(), randomUUID()];
    for (const messageId of mine) {
      await insertTestSending({ messageId, toEmail: `${messageId}@example.com`, tag });
    }
    await insertTestDelivery(mine[0], `${mine[0]}@example.com`);
    await insertTestBounce(mine[1], `${mine[1]}@example.com`);

    // A message from a different operation, and one with no tag at all.
    const other = randomUUID();
    await insertTestSending({ messageId: other, toEmail: `${other}@example.com`, tag: "some-other-release" });
    const untagged = randomUUID();
    await insertTestSending({ messageId: untagged, toEmail: `${untagged}@example.com` });

    const response = await request(app)
      .get("/internal/stats/by-tag")
      .set(getServiceHeaders())
      .query({ tag });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.messageCount).toBe(3);
    expect(response.body.emailStats.sent).toBe(3);
    expect(response.body.emailStats.bounced).toBe(1);
    expect(response.body.recipientStats.sent).toBe(3);
    expect(response.body.recipientStats.bounced).toBe(1);
  });

  it("matches with real zero outcomes once messages exist", async () => {
    const tag = "mailing-list-release-nothing-happened-yet";
    const messageId = randomUUID();
    await insertTestSending({ messageId, toEmail: `${messageId}@example.com`, tag });

    const response = await request(app)
      .get("/internal/stats/by-tag")
      .set(getServiceHeaders())
      .query({ tag });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.messageCount).toBe(1);
    expect(response.body.emailStats.bounced).toBe(0);
    expect(response.body.emailStats.unsubscribed).toBe(0);
  });

  it("can narrow an operation to one organization", async () => {
    const tag = "shared-tag";
    const mine = randomUUID();
    const theirs = randomUUID();
    await insertTestSending({ messageId: mine, toEmail: `${mine}@example.com`, tag, orgId: "org-a" });
    await insertTestSending({ messageId: theirs, toEmail: `${theirs}@example.com`, tag, orgId: "org-b" });

    const response = await request(app)
      .get("/internal/stats/by-tag")
      .set(getServiceHeaders())
      .query({ tag, orgId: "org-a" });

    expect(response.body.matched).toBe(true);
    expect(response.body.messageCount).toBe(1);
  });

  it("rejects a request with no tag", async () => {
    const response = await request(app)
      .get("/internal/stats/by-tag")
      .set(getServiceHeaders())
      .query({});

    expect(response.status).toBe(400);
  });

  it("is served on the org-scoped route too", async () => {
    const tag = "org-route-tag";
    const messageId = randomUUID();
    await insertTestSending({ messageId, toEmail: `${messageId}@example.com`, tag });

    const response = await request(app)
      .get("/orgs/stats/by-tag")
      .set(getAuthHeaders())
      .query({ tag });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(true);
    expect(response.body.messageCount).toBe(1);
  });

  it("leaves the existing run-keyed stats read exactly as it was", async () => {
    const runId = randomUUID();
    const messageId = randomUUID();
    await insertTestSending({ messageId, toEmail: `${messageId}@example.com`, runId, tag: "some-release" });

    const response = await request(app)
      .get("/internal/stats")
      .set(getServiceHeaders())
      .query({ runIds: runId });

    expect(response.status).toBe(200);
    expect(response.body.emailStats.sent).toBe(1);
    expect(response.body).not.toHaveProperty("matched");
  });
});
