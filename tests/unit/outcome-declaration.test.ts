import { describe, it, expect, vi, beforeEach } from "vitest";

const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const selectRows: any[] = [];

vi.mock("../../src/db", () => ({
  db: {
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(selectRows) }) }) }),
    })),
  },
}));

vi.mock("../../src/lib/runs-client", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/runs-client")>(
    "../../src/lib/runs-client"
  );
  return {
    RunsHttpError: actual.RunsHttpError,
    addOutcomes: vi.fn().mockResolvedValue({}),
    addPlatformOutcomes: vi.fn().mockResolvedValue({}),
  };
});

import { addOutcomes, addPlatformOutcomes, RunsHttpError } from "../../src/lib/runs-client";
import {
  MESSAGE_SENT,
  buildSendDeclaration,
  catchUpOwedDeclarations,
  declareSendOutcome,
  resetCatchUpStateForTests,
  resolveOutcomeSubject,
} from "../../src/lib/outcome-declaration";

const owed = {
  sendingId: "sending-1",
  runId: "run-1",
  payer: "org" as const,
  orgId: "org-1",
  subjectService: "transactional-email-service",
  subjectId: "subscriber-1",
  consumedOutcomeKeys: ["email_checked"],
};

describe("outcome declaration — keys and subjects", () => {
  it("declares message_sent as the one outcome a send produces", () => {
    expect(MESSAGE_SENT).toBe("message_sent");
  });

  it("names the subject the caller stated", () => {
    expect(
      resolveOutcomeSubject({
        outcomeSubject: { subjectService: "transactional-email-service", subjectId: "sub-1" },
        leadId: "lead-1",
      })
    ).toEqual({ subjectService: "transactional-email-service", subjectId: "sub-1" });
  });

  it("names the lead in lead-service when the caller sent only leadId", () => {
    expect(resolveOutcomeSubject({ leadId: "lead-1" })).toEqual({
      subjectService: "lead-service",
      subjectId: "lead-1",
    });
  });

  it("names nobody for a support mail (receipt, code, alert)", () => {
    expect(resolveOutcomeSubject({})).toBeNull();
  });

  it("builds produced message_sent + consumed keys on the same subject", () => {
    expect(
      buildSendDeclaration({ subjectService: "lead-service", subjectId: "lead-1" }, ["message_written"])
    ).toEqual({
      produced: [{ outcomeKey: "message_sent", subjectService: "lead-service", subjectId: "lead-1" }],
      consumed: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
      occurredAt: "run_started_at",
    });
    expect(buildSendDeclaration({ subjectService: "s", subjectId: "i" }, null).consumed).toEqual([]);
  });
});

describe("declareSendOutcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("declares on the org run with the run's org and marks the row declared", async () => {
    await declareSendOutcome(owed);
    expect(addOutcomes).toHaveBeenCalledWith(
      "run-1",
      {
        produced: [{ outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: "subscriber-1" }],
        consumed: [{ outcomeKey: "email_checked", subjectService: "transactional-email-service", subjectId: "subscriber-1" }],
        occurredAt: "run_started_at",
      },
      "org-1"
    );
    expect(addPlatformOutcomes).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ outcomeDeclaredAt: expect.any(Date) });
  });

  it("declares a platform-paid send on the org-less platform run", async () => {
    await declareSendOutcome({ ...owed, payer: "platform", orgId: null });
    expect(addPlatformOutcomes).toHaveBeenCalledWith("run-1", expect.any(Object));
    expect(addOutcomes).not.toHaveBeenCalled();
  });

  it("never throws on an outage and leaves the row owed for the catch-up", async () => {
    vi.mocked(addOutcomes).mockRejectedValueOnce(new RunsHttpError("502", 502));
    await expect(declareSendOutcome(owed)).resolves.toBeUndefined();
    expect(updateSet).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("FAILED, owed"));
  });

  it("stores a 4xx refusal on the row and stops retrying it", async () => {
    vi.mocked(addOutcomes).mockRejectedValueOnce(
      new RunsHttpError("runs-service POST failed: 400 - unknown_outcome_key", 400)
    );
    await declareSendOutcome(owed);
    expect(updateSet).toHaveBeenCalledWith({
      outcomeDeclareError: expect.stringContaining("unknown_outcome_key"),
    });
  });

  it("retries a 429", async () => {
    vi.mocked(addOutcomes).mockRejectedValueOnce(new RunsHttpError("429", 429));
    await declareSendOutcome(owed);
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("catchUpOwedDeclarations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCatchUpStateForTests();
    selectRows.length = 0;
  });

  it("re-declares every owed row (a replay is runs-service's already_recorded)", async () => {
    selectRows.push(
      { ...owed, sendingId: "s-1" },
      { ...owed, sendingId: "s-2", payer: "platform", orgId: null, consumedOutcomeKeys: null }
    );
    const n = await catchUpOwedDeclarations(1_000_000);
    expect(n).toBe(2);
    expect(addOutcomes).toHaveBeenCalledTimes(1);
    expect(addPlatformOutcomes).toHaveBeenCalledTimes(1);
  });

  it("declares a late (caught-up) send at its run's start, never at catch-up time", async () => {
    selectRows.push({ ...owed });
    await catchUpOwedDeclarations(1_000_000);
    expect(addOutcomes).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ occurredAt: "run_started_at" }),
      "org-1"
    );
  });

  it("runs at most once a minute", async () => {
    selectRows.push({ ...owed });
    await catchUpOwedDeclarations(1_000_000);
    const again = await catchUpOwedDeclarations(1_030_000);
    expect(again).toBe(0);
    expect(addOutcomes).toHaveBeenCalledTimes(1);
  });
});
