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
  getStreamId: vi.fn(async (_o: string, _u: string, type: string) => `${type}-stream-id`),
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

import { addCosts } from "../../src/lib/runs-client";
import { getStreamId } from "../../src/lib/key-client";
import { sendEmail } from "../../src/lib/postmark-client";
import { db } from "../../src/db";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

const validBody = {
  to: "user@example.com",
  subject: "Test",
  htmlBody: "<p>Hi</p>",
  replyTo: "prospect@example.com",
};

function sentStreams(): string[] {
  return vi.mocked(sendEmail).mock.calls.map((c) => c[0].messageStream);
}

function recordedStreams(): string[] {
  const insertResults = vi.mocked(db.insert).mock.results;
  return insertResults.map((r) => {
    const values = (r.value as any).values as ReturnType<typeof vi.fn>;
    return values.mock.calls[0][0].messageStream;
  });
}

function requestedStreamTypes(): string[] {
  return vi.mocked(getStreamId).mock.calls.map((c) => c[2]);
}

describe("POST /orgs/send — message stream", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends on the broadcast stream when no stream is asked for (unchanged default)", async () => {
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(validBody);

    expect(res.status).toBe(200);
    expect(requestedStreamTypes()).toEqual(["broadcast"]);
    expect(sentStreams()).toEqual(["broadcast-stream-id"]);
    expect(recordedStreams()).toEqual(["broadcast-stream-id"]);
  });

  it("sends person-to-person mail on the transactional stream and records it", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, stream: "transactional" });

    expect(res.status).toBe(200);
    expect(requestedStreamTypes()).toEqual(["transactional"]);
    expect(sentStreams()).toEqual(["transactional-stream-id"]);
    expect(recordedStreams()).toEqual(["transactional-stream-id"]);
    // Reply-To is forwarded exactly as the caller set it.
    expect(vi.mocked(sendEmail).mock.calls[0][0].replyTo).toBe("prospect@example.com");
  });

  it("declares the same cost on the transactional stream", async () => {
    await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, stream: "transactional" });

    expect(addCosts).toHaveBeenCalledWith(
      "org-run-1",
      [{ costName: "postmark-email-send", quantity: 1, costSource: "platform" }],
      expect.any(String),
      expect.any(String),
      expect.any(Object)
    );
  });

  it("rejects an unknown stream", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, stream: "inbound" });

    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /orgs/send/batch — per-email message stream", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves only the broadcast stream for a batch that never asks for another", async () => {
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({ emails: [{ ...validBody, to: "a@example.com" }, { ...validBody, to: "b@example.com" }] });

    expect(res.status).toBe(200);
    expect(requestedStreamTypes()).toEqual(["broadcast"]);
    expect(sentStreams()).toEqual(["broadcast-stream-id", "broadcast-stream-id"]);
  });

  it("routes each email to the stream it asked for", async () => {
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({
        emails: [
          { ...validBody, to: "a@example.com" },
          { ...validBody, to: "b@example.com", stream: "transactional" },
          { ...validBody, to: "c@example.com", stream: "broadcast" },
        ],
      });

    expect(res.status).toBe(200);
    expect(requestedStreamTypes()).toEqual(["broadcast", "transactional"]);
    expect(sentStreams()).toEqual(["broadcast-stream-id", "transactional-stream-id", "broadcast-stream-id"]);
    expect(recordedStreams()).toEqual(["broadcast-stream-id", "transactional-stream-id", "broadcast-stream-id"]);
  });
});
