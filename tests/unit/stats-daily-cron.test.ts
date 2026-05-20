import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock gold lib so the cron test doesn't need a DB connection.
vi.mock("../../src/lib/gold", () => ({
  refreshStatsDaily: vi.fn().mockResolvedValue(undefined),
}));

import { startStatsDailyCron } from "../../src/jobs/stats-daily-cron";
import { refreshStatsDaily } from "../../src/lib/gold";

describe("stats-daily-cron", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs an initial refresh shortly after start", async () => {
    startStatsDailyCron();

    expect(refreshStatsDaily).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refreshStatsDaily).toHaveBeenCalledTimes(1);
    expect(refreshStatsDaily).toHaveBeenCalledWith({ windowDays: 7 });
  });

  it("schedules subsequent refreshes on the 5-minute interval", async () => {
    startStatsDailyCron();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(refreshStatsDaily).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(refreshStatsDaily).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(refreshStatsDaily).toHaveBeenCalledTimes(3);
  });
});
