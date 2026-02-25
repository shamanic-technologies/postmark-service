import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Mock database (required by webhook routes)
vi.mock("../../src/db", () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock key-client (required by postmark-client)
vi.mock("../../src/lib/key-client", () => ({
  getAppKey: vi.fn(),
}));

import { createTestApp } from "../helpers/test-app";

describe("GET /webhooks/postmark/url", () => {
  const app = createTestApp();

  it("should return the webhook URL and event list", async () => {
    const res = await request(app).get("/webhooks/postmark/url");

    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toContain("/webhooks/postmark");
    expect(res.body.events).toEqual([
      "Delivery",
      "Bounce",
      "Open",
      "Click",
      "SpamComplaint",
      "SubscriptionChange",
    ]);
    expect(res.body.instructions).toBeDefined();
  });

  it("should not require authentication", async () => {
    const res = await request(app).get("/webhooks/postmark/url");

    expect(res.status).toBe(200);
  });
});
