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
    // leadId conflict guard: no other lead holds this address.
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "sending-1" }]),
      })),
    })),
  },
}));

vi.mock("../../src/lib/outcome-declaration", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/outcome-declaration")>(
    "../../src/lib/outcome-declaration"
  );
  return { ...actual, scheduleOutcomeDeclaration: vi.fn() };
});

vi.mock("../../src/lib/silver", () => ({
  upsertSilver: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmail } from "../../src/lib/postmark-client";
import { createRun } from "../../src/lib/runs-client";
import { SEND_SUPPORT } from "../../src/lib/send-support";
import { scheduleOutcomeDeclaration } from "../../src/lib/outcome-declaration";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

const validBody = { to: "user@example.com", subject: "Test", htmlBody: "<p>Hi</p>" };
const subscriber = { subjectService: "transactional-email-service", subjectId: "subscriber-1" };

describe("POST /orgs/send — the outcome a send produced", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => vi.clearAllMocks());

  it("declares message_sent for the subject the caller named", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, outcomeSubject: subscriber, consumedOutcomeKeys: ["email_checked"] });
    expect(res.status).toBe(200);
    expect(scheduleOutcomeDeclaration).toHaveBeenCalledWith({
      sendingId: "sending-1",
      runId: "org-run-1",
      payer: "org",
      orgId: expect.any(String),
      ...subscriber,
      consumedOutcomeKeys: ["email_checked"],
    });
  });

  it("names the lead in lead-service when only leadId is sent", async () => {
    await request(app).post("/orgs/send").set(getAuthHeaders()).send({ ...validBody, leadId: "lead-1" });
    expect(scheduleOutcomeDeclaration).toHaveBeenCalledWith(
      expect.objectContaining({ subjectService: "lead-service", subjectId: "lead-1", consumedOutcomeKeys: null })
    );
  });

  it("declares nothing for a support mail that names nobody, and opens its run as support", async () => {
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(validBody);
    expect(res.status).toBe(200);
    expect(scheduleOutcomeDeclaration).not.toHaveBeenCalled();
    expect(vi.mocked(createRun).mock.calls[0][0]).toMatchObject({ support: SEND_SUPPORT });
  });

  it("a send naming its person opens a production run (no support mark)", async () => {
    await request(app).post("/orgs/send").set(getAuthHeaders()).send({ ...validBody, leadId: "lead-1" });
    expect(vi.mocked(createRun).mock.calls[0][0]).not.toHaveProperty("support");
  });

  it("declares nothing when Postmark rejected the send", async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({
      success: false,
      messageId: undefined,
      submittedAt: undefined,
      errorCode: 406,
      message: "Inactive recipient",
    } as any);
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, outcomeSubject: subscriber });
    expect(res.status).toBe(400);
    expect(scheduleOutcomeDeclaration).not.toHaveBeenCalled();
  });

  it("refuses consumed keys without a subject", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, consumedOutcomeKeys: ["email_checked"] });
    expect(res.status).toBe(400);
  });
});

describe("POST /orgs/send/batch — per-email outcome", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  beforeEach(() => vi.clearAllMocks());

  it("declares only for the emails that name a subject", async () => {
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({ emails: [{ ...validBody, outcomeSubject: subscriber }, { ...validBody, tag: "receipt" }] });
    expect(res.status).toBe(200);
    expect(scheduleOutcomeDeclaration).toHaveBeenCalledTimes(1);
    expect(scheduleOutcomeDeclaration).toHaveBeenCalledWith(expect.objectContaining(subscriber));
  });
});
