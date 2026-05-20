import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

const { dbInsert, dbValues, dbOnConflictDoNothing } = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbValues: vi.fn(),
  dbOnConflictDoNothing: vi.fn(),
}));

vi.mock("../../src/db", () => ({
  db: {
    insert: dbInsert,
    values: dbValues,
    onConflictDoNothing: dbOnConflictDoNothing,
  },
}));

vi.mock("../../src/lib/key-client", () => ({
  getAppKey: vi.fn(),
}));

// Mock silver materialization — this test exercises the webhook router only,
// not the bronze-to-silver UPSERT.
vi.mock("../../src/lib/silver", () => ({
  upsertSilver: vi.fn().mockResolvedValue(undefined),
}));

import { createTestApp } from "../helpers/test-app";
import { createInboundPayload, createDeliveryPayload } from "../fixtures/postmark-payloads";

describe("POST /webhooks/postmark — Inbound forwarding", () => {
  const app = createTestApp();
  const originalUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const originalKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

  beforeEach(() => {
    process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email-gateway.test";
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-gateway-key";
    vi.restoreAllMocks();
    dbInsert.mockReset().mockReturnThis();
    dbValues.mockReset().mockReturnThis();
    dbOnConflictDoNothing.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl !== undefined) {
      process.env.EMAIL_GATEWAY_SERVICE_URL = originalUrl;
    } else {
      delete process.env.EMAIL_GATEWAY_SERVICE_URL;
    }
    if (originalKey !== undefined) {
      process.env.EMAIL_GATEWAY_SERVICE_API_KEY = originalKey;
    } else {
      delete process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
    }
  });

  it("forwards Inbound payload to email-gateway and returns 200 on gateway 200", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const payload = createInboundPayload("msg-abc");
    const response = await request(app).post("/webhooks/postmark").send(payload);

    expect(response.status).toBe(200);
    expect(response.body.recordType).toBe("Inbound");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://email-gateway.test/inbound/postmark");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-gateway-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("returns 502 when email-gateway responds with 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("internal error", { status: 500 })
    );

    const payload = createInboundPayload("msg-fail");
    const response = await request(app).post("/webhooks/postmark").send(payload);

    expect(response.status).toBe(502);
    expect(response.body.error).toBeDefined();
  });

  it("returns 502 when fetch throws (network error)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const payload = createInboundPayload("msg-neterr");
    const response = await request(app).post("/webhooks/postmark").send(payload);

    expect(response.status).toBe(502);
    expect(response.body.error).toBeDefined();
  });

  it("does NOT call email-gateway for non-Inbound RecordType (Delivery)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const payload = createDeliveryPayload("msg-delivery");

    const response = await request(app).post("/webhooks/postmark").send(payload);

    expect(response.status).toBe(200);
    expect(response.body.recordType).toBe("Delivery");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });
});
