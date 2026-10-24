import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "org-run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
  createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-1" }),
  updatePlatformRun: vi.fn().mockResolvedValue({}),
  addPlatformCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/lib/postmark-client", () => ({
  sendEmail: vi.fn(),
  sendEmailWithToken: vi.fn().mockResolvedValue({
    success: true,
    messageId: "11111111-1111-4111-8111-111111111111",
    submittedAt: new Date("2026-10-12T10:00:00Z"),
    errorCode: 0,
    message: "OK",
  }),
}));

vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn(),
  getStreamId: vi.fn(),
  getFromAddress: vi.fn(),
  getPlatformKey: vi.fn(async (provider: string) => `platform:${provider}`),
}));

vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn(),
}));

const insertValues = vi.fn(() => ({ returning: vi.fn(() => [{ id: "sending-1" }]) }));
vi.mock("../../src/db", () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));

vi.mock("../../src/lib/silver", () => ({
  upsertSilver: vi.fn().mockResolvedValue(undefined),
}));

import {
  createRun,
  addCosts,
  createPlatformRun,
  addPlatformCosts,
  updatePlatformRun,
} from "../../src/lib/runs-client";
import { getOrgKey, getPlatformKey } from "../../src/lib/key-client";
import { authorizeCredits } from "../../src/lib/billing-client";
import { sendEmail, sendEmailWithToken } from "../../src/lib/postmark-client";
import request from "supertest";
import { createTestApp, getServiceHeaders } from "../helpers/test-app";

const body = {
  payer: "platform",
  to: "kevin@distribute.you",
  subject: "Your sign-up code",
  textBody: "123456",
  tag: "signup_code",
  stream: "transactional",
};

describe("POST /internal/platform-send — org-less, platform-paid", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends with platform keys only, on an org-less platform run, with no credit authorization", async () => {
    const res = await request(app)
      .post("/internal/platform-send")
      .set({ ...getServiceHeaders(), "x-run-id": "caller-run-1" })
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      messageId: "11111111-1111-4111-8111-111111111111",
      sendingId: "sending-1",
      runId: "platform-run-1",
    });

    // Keys: platform only, never org-resolved
    expect(vi.mocked(getPlatformKey).mock.calls.map((c) => c[0])).toEqual([
      "postmark",
      "postmark-transactional-stream",
      "postmark-from-address",
    ]);
    expect(getOrgKey).not.toHaveBeenCalled();

    // Billing: never touched
    expect(authorizeCredits).not.toHaveBeenCalled();

    // Ledger: org-less platform run + the usual send cost
    expect(createPlatformRun).toHaveBeenCalledTimes(1);
    // Names nobody: support from creation (LEDGER-HISTORY-1024).
    expect(vi.mocked(createPlatformRun).mock.calls[0][0]).toMatchObject({ support: { kind: "product_feature" } });
    expect(createRun).not.toHaveBeenCalled();
    expect(addCosts).not.toHaveBeenCalled();
    expect(addPlatformCosts).toHaveBeenCalledWith(
      "platform-run-1",
      [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
      {}
    );
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "completed", undefined, {});

    // Delivery: platform token, transactional stream, platform from
    const sent = vi.mocked(sendEmailWithToken).mock.calls[0][0];
    expect(sent.serverToken).toBe("platform:postmark");
    expect(sent.messageStream).toBe("platform:postmark-transactional-stream");
    expect(sent.from).toBe("platform:postmark-from-address");
    expect(sendEmail).not.toHaveBeenCalled();

    // Record: kept, with no org and payer platform
    const row = (insertValues.mock.calls[0] as any[])[0];
    expect(row).toMatchObject({
      orgId: null,
      userId: null,
      payer: "platform",
      runId: "platform-run-1",
      parentRunId: "caller-run-1",
      toEmail: "kevin@distribute.you",
      tag: "signup_code",
    });
  });

  it("uses the broadcast stream when none is asked for, and the caller's from when given", async () => {
    const res = await request(app)
      .post("/internal/platform-send")
      .set(getServiceHeaders())
      .send({ ...body, stream: undefined, from: "hello@distribute.you" });

    expect(res.status).toBe(200);
    expect(vi.mocked(getPlatformKey).mock.calls.map((c) => c[0])).toEqual([
      "postmark",
      "postmark-broadcast-stream",
    ]);
    expect(vi.mocked(sendEmailWithToken).mock.calls[0][0].from).toBe("hello@distribute.you");
  });

  it("refuses a request that is not platform-paid (absent payer)", async () => {
    const { payer: _p, ...noPayer } = body;
    const res = await request(app).post("/internal/platform-send").set(getServiceHeaders()).send(noPayer);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PLATFORM_PAYER_REQUIRED");
    expect(sendEmailWithToken).not.toHaveBeenCalled();
    expect(createPlatformRun).not.toHaveBeenCalled();
    expect(getPlatformKey).not.toHaveBeenCalled();
  });

  it("refuses payer: org", async () => {
    const res = await request(app)
      .post("/internal/platform-send")
      .set(getServiceHeaders())
      .send({ ...body, payer: "org" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PLATFORM_PAYER_REQUIRED");
    expect(sendEmailWithToken).not.toHaveBeenCalled();
  });

  it("refuses a request carrying an org or a user", async () => {
    for (const h of [{ "x-org-id": "org-1" }, { "x-user-id": "user-1" }]) {
      const res = await request(app)
        .post("/internal/platform-send")
        .set({ ...getServiceHeaders(), ...h })
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("IDENTITY_NOT_ALLOWED");
    }
    expect(sendEmailWithToken).not.toHaveBeenCalled();
    expect(authorizeCredits).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with INVALID_REQUEST", async () => {
    const res = await request(app)
      .post("/internal/platform-send")
      .set(getServiceHeaders())
      .send({ payer: "platform", to: "a@b.c", subject: "x" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  it("requires the service API key", async () => {
    const res = await request(app).post("/internal/platform-send").send(body);
    expect(res.status).toBe(401);
  });

  it("is a 502, never a 200, when Postmark rejects the message; run failed, no cost", async () => {
    vi.mocked(sendEmailWithToken).mockResolvedValueOnce({
      success: false,
      errorCode: 406,
      message: "Inactive recipient",
    });
    const res = await request(app).post("/internal/platform-send").set(getServiceHeaders()).send(body);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "POSTMARK_REJECTED", errorCode: 406, message: "Inactive recipient" });
    expect(addPlatformCosts).not.toHaveBeenCalled();
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "failed", "Inactive recipient", {});
  });

  it("is a 500 SEND_FAILED when a platform key cannot be resolved, and nothing is sent", async () => {
    vi.mocked(getPlatformKey).mockRejectedValueOnce(new Error("key-service down"));
    const res = await request(app).post("/internal/platform-send").set(getServiceHeaders()).send(body);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SEND_FAILED");
    expect(sendEmailWithToken).not.toHaveBeenCalled();
    expect(createPlatformRun).not.toHaveBeenCalled();
  });

  it("is a 500 SEND_FAILED when the platform run cannot be opened, and nothing is sent", async () => {
    vi.mocked(createPlatformRun).mockRejectedValueOnce(new Error("runs-service down"));
    const res = await request(app).post("/internal/platform-send").set(getServiceHeaders()).send(body);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SEND_FAILED");
    expect(sendEmailWithToken).not.toHaveBeenCalled();
  });
});
