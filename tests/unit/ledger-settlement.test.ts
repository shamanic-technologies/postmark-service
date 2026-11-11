import { describe, it, expect, vi, beforeEach } from "vitest";

// SIGNUP-EMAILS-1111: a send answers once Postmark accepted it; the run's cost +
// completion settle after, owed on the sending row until runs-service accepts.

vi.mock("../../src/lib/runs-client", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/runs-client")>("../../src/lib/runs-client");
  return {
    ...actual,
    createRun: vi.fn().mockResolvedValue({ id: "org-run-1" }),
    updateRun: vi.fn().mockResolvedValue({}),
    addCosts: vi.fn().mockResolvedValue({ costs: [] }),
    createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-1" }),
    updatePlatformRun: vi.fn().mockResolvedValue({}),
    addPlatformCosts: vi.fn().mockResolvedValue({ costs: [] }),
    addOutcomes: vi.fn().mockResolvedValue({}),
    addPlatformOutcomes: vi.fn().mockResolvedValue({}),
  };
});

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
  getOrgKey: vi.fn().mockResolvedValue({ provider: "postmark", key: "platform-token", keySource: "platform" }),
  getStreamId: vi.fn().mockResolvedValue("broadcast"),
  getFromAddress: vi.fn().mockResolvedValue("noreply@example.com"),
}));

vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 500, required_cents: 1 }),
}));

const inserted: any[] = [];
const updates: any[] = [];
let owedRows: any[] = [];
vi.mock("../../src/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
          orderBy: () => ({ limit: () => Promise.resolve(owedRows) }),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserted.push(v);
        return { returning: vi.fn(() => [{ id: "sending-1" }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  },
}));

vi.mock("../../src/lib/silver", () => ({ upsertSilver: vi.fn().mockResolvedValue(undefined) }));

import { addCosts, updateRun, addOutcomes, addPlatformCosts, updatePlatformRun, RunsHttpError } from "../../src/lib/runs-client";
import {
  settleSendLedger,
  catchUpOwedLedgers,
  resetLedgerCatchUpStateForTests,
  sendCostIdempotencyKey,
  trackingHeadersOf,
  OwedLedger,
} from "../../src/lib/ledger-settlement";
import { resetCatchUpStateForTests } from "../../src/lib/outcome-declaration";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app";

const validBody = { to: "user@example.com", subject: "Welcome", htmlBody: "<p>Hi</p>" };
const flush = () => new Promise((r) => setTimeout(r, 20));

const orgOwed: OwedLedger = {
  sendingId: "sending-1",
  runId: "org-run-1",
  payer: "org",
  orgId: "org-1",
  userId: "user-1",
  status: "completed",
  costSource: "platform",
  error: null,
  trackingHeaders: { "x-campaign-id": "c-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updates.length = 0;
  owedRows = [];
  resetLedgerCatchUpStateForTests();
  resetCatchUpStateForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("POST /orgs/send — answers once Postmark accepted, whatever runs-service takes", () => {
  const app = createTestApp();

  // The 2026-11-11 welcome mail: Postmark accepted at +0.9 s, the run completed at
  // +15.7 s, email-gateway aborted at 10 s and sent a second copy.
  it("answers 200 while the cost + completion are still pending on runs-service", async () => {
    let release!: () => void;
    vi.mocked(addCosts).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ costs: [] }); })
    );
    const started = Date.now();
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe("msg-123");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(updateRun).not.toHaveBeenCalled();

    release();
    await flush();
    expect(updateRun).toHaveBeenCalledWith("org-run-1", "completed", "test-org-id", "test-user-id", undefined, {});
    expect(updates).toContainEqual({ ledgerSettledAt: expect.any(Date) });
  });

  it("records what the run owes in the same INSERT as the send", async () => {
    await request(app).post("/orgs/send").set(getAuthHeaders()).send(validBody);
    expect(inserted[0]).toMatchObject({ ledgerStatus: "completed", ledgerCostSource: "platform" });
  });

  it("a send Postmark refused answers 400 and owes a failed run", async () => {
    const { sendEmail } = await import("../../src/lib/postmark-client");
    vi.mocked(sendEmail).mockResolvedValueOnce({
      success: false, messageId: undefined, submittedAt: undefined, errorCode: 406, message: "Inactive recipient",
    } as any);
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(validBody);
    expect(res.status).toBe(400);
    expect(inserted[0]).toMatchObject({ ledgerStatus: "failed", ledgerCostSource: null });
    await flush();
    expect(addCosts).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("org-run-1", "failed", "test-org-id", "test-user-id", "Inactive recipient", {});
  });

  it("declares the outcome only after the run settled", async () => {
    await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...validBody, leadId: "lead-1" });
    await flush();
    const costAt = vi.mocked(addCosts).mock.invocationCallOrder[0];
    const doneAt = vi.mocked(updateRun).mock.invocationCallOrder[0];
    const outcomeAt = vi.mocked(addOutcomes).mock.invocationCallOrder[0];
    expect(costAt).toBeLessThan(doneAt);
    expect(doneAt).toBeLessThan(outcomeAt);
  });
});

describe("settleSendLedger", () => {
  it("declares the cost once per send (idempotency key) then completes the run", async () => {
    expect(await settleSendLedger(orgOwed)).toBe(true);
    expect(addCosts).toHaveBeenCalledWith(
      "org-run-1",
      [{ costName: "postmark-email-send", quantity: 1, costSource: "platform", idempotencyKey: sendCostIdempotencyKey("sending-1") }],
      "org-1",
      "user-1",
      { "x-campaign-id": "c-1" }
    );
    expect(updateRun).toHaveBeenCalledWith("org-run-1", "completed", "org-1", "user-1", undefined, { "x-campaign-id": "c-1" });
    expect(updates).toEqual([{ ledgerSettledAt: expect.any(Date) }]);
  });

  it("settles a platform-paid send on the platform run, never with org identity", async () => {
    await settleSendLedger({ ...orgOwed, payer: "platform", runId: "platform-run-1", trackingHeaders: {} });
    expect(addPlatformCosts).toHaveBeenCalledWith(
      "platform-run-1",
      [expect.objectContaining({ idempotencyKey: "postmark-email-send:sending-1" })],
      {}
    );
    expect(updatePlatformRun).toHaveBeenCalledWith("platform-run-1", "completed", undefined, {});
    expect(addCosts).not.toHaveBeenCalled();
  });

  it("an outage leaves the row owed (no mark) for the catch-up", async () => {
    vi.mocked(updateRun).mockRejectedValueOnce(new RunsHttpError("runs-service PATCH failed: 503", 503));
    expect(await settleSendLedger(orgOwed)).toBe(false);
    expect(updates).toEqual([]);
  });

  it("a 4xx refusal is stored and never retried", async () => {
    vi.mocked(addCosts).mockRejectedValueOnce(new RunsHttpError("runs-service POST failed: 404 - Run not found", 404));
    expect(await settleSendLedger(orgOwed)).toBe(false);
    expect(updates).toEqual([{ ledgerSettleError: expect.stringContaining("404") }]);
  });
});

describe("catchUpOwedLedgers", () => {
  it("settles owed rows rebuilt from the sending row, at most once a minute", async () => {
    owedRows = [{
      id: "sending-9", runId: "org-run-9", payer: "org", orgId: "org-1", userId: null,
      ledgerStatus: "completed", ledgerCostSource: "org", message: "OK",
      campaignId: "c-9", brandIds: ["b-1", "b-2"], featureSlug: null, workflowSlug: "w", audienceId: null,
    }];
    const now = Date.now();
    expect(await catchUpOwedLedgers(now)).toBe(1);
    expect(addCosts).toHaveBeenCalledWith(
      "org-run-9",
      [expect.objectContaining({ costSource: "org", idempotencyKey: "postmark-email-send:sending-9" })],
      "org-1",
      "",
      { "x-campaign-id": "c-9", "x-brand-id": "b-1,b-2", "x-workflow-slug": "w" }
    );
    expect(await catchUpOwedLedgers(now + 1000)).toBe(0);
  });

  it("trackingHeadersOf drops empty fields", () => {
    expect(trackingHeadersOf({ campaignId: null, brandIds: [], featureSlug: "f", workflowSlug: null, audienceId: null }))
      .toEqual({ "x-feature-slug": "f" });
  });
});
