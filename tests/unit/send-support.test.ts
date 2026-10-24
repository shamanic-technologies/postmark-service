import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("../../src/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("../../src/lib/runs-client", () => ({ markOwnRunsSupport: vi.fn() }));

import { markOwnRunsSupport } from "../../src/lib/runs-client";
import {
  SEND_SUPPORT,
  sendSupportFor,
  backfillSendSupportMarks,
  BACKFILL_MARKED_BY,
} from "../../src/lib/send-support";

const selection = (o: Partial<Record<string, unknown>> = {}) => ({
  matchedRunCount: 3, toMarkCount: 3, alreadyMarkedCount: 0, declaresOutcomesCount: 0,
  onOutcomeNowCount: 0, leftOnOutcomeCount: 0, spend: { grossCents: "1", netCents: "1" },
  maxRuns: 50000, tooMany: false, ...o,
});

describe("sendSupportFor", () => {
  it("a send naming nobody is support product_feature", () => {
    expect(sendSupportFor(null)).toEqual(SEND_SUPPORT);
    expect(SEND_SUPPORT.kind).toBe("product_feature");
  });
  it("a send naming its person is production: no mark", () => {
    expect(sendSupportFor({ subjectService: "lead-service", subjectId: "l1" })).toBeUndefined();
  });
});

describe("backfillSendSupportMarks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute
      .mockResolvedValueOnce({ rows: [{ cutover: new Date("2026-10-23T14:33:00Z") }] })
      .mockResolvedValueOnce({ rows: [{ run_id: "r1" }, { run_id: "r2" }] });
  });

  it("preview writes nothing", async () => {
    vi.mocked(markOwnRunsSupport).mockResolvedValue(selection() as never);
    const report = await backfillSendSupportMarks(false);
    expect(report.cutover).toBe("2026-10-23T14:33:00.000Z");
    expect(vi.mocked(markOwnRunsSupport).mock.calls.map((c) => c[0])).toEqual(["preview", "preview"]);
  });

  it("before the cutover: our runs with spend, never one riding an outcome; after: our own subject-less sends", async () => {
    vi.mocked(markOwnRunsSupport).mockResolvedValue(selection() as never);
    await backfillSendSupportMarks(true);
    const calls = vi.mocked(markOwnRunsSupport).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(["preview", "apply", "preview", "apply"]);
    expect(calls[1][1]).toEqual({
      ...SEND_SUPPORT,
      markedBy: BACKFILL_MARKED_BY,
      taskNames: ["email-send"],
      startedBefore: "2026-10-23T14:33:00.000Z",
      withSpendOnly: true,
      offOutcomeOnly: true,
    });
    expect(calls[3][1]).toEqual({ ...SEND_SUPPORT, markedBy: BACKFILL_MARKED_BY, runIds: ["r1", "r2"] });
  });

  it("idempotent: nothing left to mark = no apply", async () => {
    vi.mocked(markOwnRunsSupport).mockResolvedValue(selection({ toMarkCount: 0, alreadyMarkedCount: 3 }) as never);
    await backfillSendSupportMarks(true);
    expect(vi.mocked(markOwnRunsSupport).mock.calls.map((c) => c[0])).toEqual(["preview", "preview"]);
  });

  it("refuses to take spend off production", async () => {
    vi.mocked(markOwnRunsSupport)
      .mockResolvedValueOnce(selection({ toMarkCount: 0 }) as never)
      .mockResolvedValueOnce(selection({ onOutcomeNowCount: 1 }) as never);
    await expect(backfillSendSupportMarks(true)).rejects.toThrow(/ride an ancestor's outcome/);
    expect(vi.mocked(markOwnRunsSupport).mock.calls.map((c) => c[0])).toEqual(["preview", "preview"]);
  });

  it("fails loud when no send has named a subject yet", async () => {
    execute.mockReset().mockResolvedValueOnce({ rows: [{ cutover: null }] });
    await expect(backfillSendSupportMarks(true)).rejects.toThrow(/cutover unknown/);
  });
});
