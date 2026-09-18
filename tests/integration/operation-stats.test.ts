import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getServiceHeaders } from "../helpers/test-app";
import {
  cleanTestData,
  closeDb,
  insertTestSending,
  insertTestDelivery,
  insertTestBounce,
  insertTestSubscriptionChange,
  randomUUID,
} from "../helpers/test-db";

/**
 * GET /internal/operations/:operationRunId/stats
 *
 * The read that lets a caller ask about the whole operation it performed, keyed on
 * its OWN run rather than on the per-message child run this service mints — and that
 * refuses to answer with zeros when it matched nothing.
 */
describe("GET /internal/operations/:operationRunId/stats", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("aggregates every message sent under the caller's run in one request", async () => {
    const operationRunId = randomUUID();

    const delivered = randomUUID();
    const bounced = randomUUID();
    const unsubscribed = randomUUID();
    await insertTestSending({ messageId: delivered, toEmail: "a@example.com", parentRunId: operationRunId, runId: randomUUID() });
    await insertTestSending({ messageId: bounced, toEmail: "b@example.com", parentRunId: operationRunId, runId: randomUUID() });
    await insertTestSending({ messageId: unsubscribed, toEmail: "c@example.com", parentRunId: operationRunId, runId: randomUUID() });
    await insertTestDelivery(delivered, "a@example.com");
    await insertTestBounce(bounced, "b@example.com");
    await insertTestSubscriptionChange(unsubscribed, "c@example.com", true);

    // A message from a different operation must not leak in.
    const other = randomUUID();
    await insertTestSending({ messageId: other, toEmail: "d@example.com", parentRunId: randomUUID(), runId: randomUUID() });

    const response = await request(app)
      .get(`/internal/operations/${operationRunId}/stats`)
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.operationRunId).toBe(operationRunId);
    expect(response.body.messagesMatched).toBe(3);
    expect(response.body.recipientsMatched).toBe(3);
    expect(response.body.recipientStats.sent).toBe(3);
    expect(response.body.recipientStats.delivered).toBe(1);
    expect(response.body.recipientStats.bounced).toBe(1);
    expect(response.body.recipientStats.unsubscribed).toBe(1);
    expect(response.body.emailStats.sent).toBe(3);
    expect(response.body.emailStats.bounced).toBe(1);
    expect(response.body.firstMessageAt).toEqual(expect.any(String));
    expect(response.body.lastMessageAt).toEqual(expect.any(String));
  });

  it("reports an operation it has no messages for as unmatched, not as zeros", async () => {
    await insertTestSending({ messageId: randomUUID(), parentRunId: randomUUID(), runId: randomUUID() });

    const response = await request(app)
      .get(`/internal/operations/${randomUUID()}/stats`)
      .set(getServiceHeaders());

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("OPERATION_NOT_FOUND");
    expect(response.body.messagesMatched).toBe(0);
    // No stats block at all — there are no zeros a consumer could read as healthy.
    expect(response.body.recipientStats).toBeUndefined();
    expect(response.body.emailStats).toBeUndefined();
  });

  it("distinguishes a measured all-zero outcome from an unmatched operation", async () => {
    const operationRunId = randomUUID();
    // Sent, but nothing has come back yet: a real zero on every outcome.
    await insertTestSending({ messageId: randomUUID(), toEmail: "e@example.com", parentRunId: operationRunId, runId: randomUUID() });

    const response = await request(app)
      .get(`/internal/operations/${operationRunId}/stats`)
      .set(getServiceHeaders());

    expect(response.status).toBe(200);
    expect(response.body.messagesMatched).toBe(1);
    expect(response.body.recipientStats.delivered).toBe(0);
    expect(response.body.recipientStats.bounced).toBe(0);
    expect(response.body.recipientStats.unsubscribed).toBe(0);
  });

  it("does not answer for the per-message child run (that is what /stats?runIds= is for)", async () => {
    const operationRunId = randomUUID();
    const childRunId = randomUUID();
    await insertTestSending({ messageId: randomUUID(), parentRunId: operationRunId, runId: childRunId });

    const byChild = await request(app)
      .get(`/internal/operations/${childRunId}/stats`)
      .set(getServiceHeaders());
    expect(byChild.status).toBe(404);

    const byOperation = await request(app)
      .get(`/internal/operations/${operationRunId}/stats`)
      .set(getServiceHeaders());
    expect(byOperation.status).toBe(200);
    expect(byOperation.body.messagesMatched).toBe(1);
  });

  it("requires service auth", async () => {
    const response = await request(app).get(`/internal/operations/${randomUUID()}/stats`);
    expect(response.status).toBe(401);
  });

  it("leaves the existing runIds filter behaving exactly as before", async () => {
    const operationRunId = randomUUID();
    const childRunId = randomUUID();
    await insertTestSending({ messageId: randomUUID(), toEmail: "f@example.com", parentRunId: operationRunId, runId: childRunId });

    const byChild = await request(app)
      .get("/internal/stats")
      .set(getServiceHeaders())
      .query({ runIds: childRunId });
    expect(byChild.status).toBe(200);
    expect(byChild.body.recipientStats.sent).toBe(1);

    // The parent run is still NOT a runIds match — that filter's meaning is unchanged.
    const byParent = await request(app)
      .get("/internal/stats")
      .set(getServiceHeaders())
      .query({ runIds: operationRunId });
    expect(byParent.status).toBe(200);
    expect(byParent.body.recipientStats.sent).toBe(0);
  });
});
