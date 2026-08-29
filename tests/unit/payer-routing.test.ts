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
  sendEmail: vi.fn().mockResolvedValue({
    success: true,
    messageId: "msg-123",
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  }),
}));

vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn().mockResolvedValue({
    provider: "postmark",
    key: "platform-token",
    keySource: "platform",
  }),
  getStreamId: vi.fn().mockResolvedValue("broadcast"),
  getFromAddress: vi.fn().mockResolvedValue("noreply@example.com"),
}));

vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({
    sufficient: true,
    balance_cents: 500,
    required_cents: 1,
  }),
}));

vi.mock("../../src/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "sending-1" }]),
      })),
    })),
  },
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
import { authorizeCredits } from "../../src/lib/billing-client";
import { resolvePayer } from "../../src/lib/payer";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

const validBody = {
  to: "user@example.com",
  subject: "Test",
  htmlBody: "<p>Hi</p>",
};

describe("resolvePayer", () => {
  it("takes the caller's explicit classification first", () => {
    expect(resolvePayer({ payer: "platform", tag: "cold-outreach" })).toBe("platform");
    expect(resolvePayer({ payer: "org", tag: "credits-reload-failed" })).toBe("org");
  });

  it("falls back to the known platform lifecycle tags", () => {
    expect(resolvePayer({ tag: "credits-reload-failed" })).toBe("platform");
    expect(resolvePayer({ tag: "welcome" })).toBe("platform");
  });

  it("bills the org for anything it does not recognise", () => {
    expect(resolvePayer({ tag: "campaign_created" })).toBe("org");
    expect(resolvePayer({ tag: null })).toBe("org");
    expect(resolvePayer({})).toBe("org");
  });
});

describe("POST /orgs/send — who the spend is declared against", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares an ordinary send on the org's run and bills the org", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send(validBody);

    expect(res.status).toBe(200);
    expect(createRun).toHaveBeenCalled();
    expect(addCosts).toHaveBeenCalledWith(
      "org-run-1",
      [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
      expect.any(String),
      expect.any(String),
      expect.any(Object)
    );
    expect(createPlatformRun).not.toHaveBeenCalled();
    expect(authorizeCredits).toHaveBeenCalled();
  });

  // The 2026-08-29 storm: this mail reports that the org's card was declined, and
  // it was billed to that org — so sending it re-entered the charge path it was
  // reporting on. Skipping the authorize gate stopped the loop; declaring the cost
  // on an org-less platform run is what stops the org paying for it at all.
  it("declares a billing notification on an org-less platform run", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, tag: "credits-reload-failed" });

    expect(res.status).toBe(200);
    expect(createPlatformRun).toHaveBeenCalledWith(
      { serviceName: "postmark-service", taskName: "email-send" },
      expect.any(Object)
    );
    expect(addPlatformCosts).toHaveBeenCalledWith(
      "platform-run-1",
      [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
      expect.any(Object)
    );
    expect(updatePlatformRun).toHaveBeenCalledWith(
      "platform-run-1",
      "completed",
      undefined,
      expect.any(Object)
    );
    expect(createRun).not.toHaveBeenCalled();
    expect(addCosts).not.toHaveBeenCalled();
    expect(authorizeCredits).not.toHaveBeenCalled();
  });

  // The tag allowlist cannot be complete — transactional-email-service reads the
  // eventType out of its own templates table. An explicit payer is how a caller
  // classifies a lifecycle mail this repo has never heard of.
  it("honours an explicit platform payer on a tag it does not know", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, tag: "dunning-final-notice", payer: "platform" });

    expect(res.status).toBe(200);
    expect(createPlatformRun).toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(authorizeCredits).not.toHaveBeenCalled();
  });

  it("honours an explicit org payer over the tag allowlist", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, tag: "welcome", payer: "org" });

    expect(res.status).toBe(200);
    expect(createRun).toHaveBeenCalled();
    expect(createPlatformRun).not.toHaveBeenCalled();
    expect(authorizeCredits).toHaveBeenCalled();
  });

  it("still declares the spend when the platform pays", async () => {
    await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, tag: "welcome" });

    // Not billing the org is not the same as not measuring the send.
    expect(addPlatformCosts).toHaveBeenCalledTimes(1);
  });

  it("fails the send loudly when the platform run cannot be opened", async () => {
    vi.mocked(createPlatformRun).mockRejectedValueOnce(
      new Error("runs-service POST /v1/platform-runs failed: 502 - Bad Gateway")
    );

    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, tag: "welcome" });

    expect(res.status).toBe(500);
  });
});

describe("POST /orgs/send/batch — per-email payer", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authorizes only the org-paid emails and splits the runs", async () => {
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({
        emails: [
          { ...validBody, to: "a@example.com", tag: "campaign_created" },
          { ...validBody, to: "b@example.com", tag: "credit-depleted" },
          { ...validBody, to: "c@example.com", tag: "anything", payer: "platform" },
        ],
      });

    expect(res.status).toBe(200);
    expect(authorizeCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ costName: "postmark-email-send", quantity: 1 }],
      })
    );
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createPlatformRun).toHaveBeenCalledTimes(2);
    expect(addCosts).toHaveBeenCalledTimes(1);
    expect(addPlatformCosts).toHaveBeenCalledTimes(2);
  });

  it("skips the gate entirely for an all-platform batch", async () => {
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({
        emails: [
          { ...validBody, to: "a@example.com", tag: "welcome" },
          { ...validBody, to: "b@example.com", tag: "credits-reload-failed" },
        ],
      });

    expect(res.status).toBe(200);
    expect(authorizeCredits).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(createPlatformRun).toHaveBeenCalledTimes(2);
  });
});
