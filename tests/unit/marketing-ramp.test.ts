import { describe, it, expect, vi, beforeEach } from "vitest";

const counted = { n: 0 };
vi.mock("../../src/db", () => ({
  db: { select: vi.fn(() => ({ from: () => ({ where: async () => [{ n: counted.n }] }) })) },
}));
vi.mock("../../src/lib/key-client", () => ({
  getPlatformKey: vi.fn(async () => JSON.stringify({ accessKeyId: "a", secretAccessKey: "b", region: "us-east-1" })),
}));
vi.mock("../../src/lib/ses-client", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/ses-client")>()),
  awsRequest: vi.fn(async () => ({ status: 200, text: JSON.stringify({ SendQuota: { Max24HourSend: 50000 } }) })),
}));

import { rampCapFor, marketingRampAllows, resetMarketingRampForTests } from "../../src/lib/marketing-ramp";
import { awsRequest } from "../../src/lib/ses-client";
import { db } from "../../src/db";

describe("rampCapFor — double a day from 500, capped at 80 % of SES's quota", () => {
  it("follows 500, 1k, 2k, ... then the quota", () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, 19 + d, 15));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => rampCapFor(day(d), 50000))).toEqual([500, 1000, 2000, 4000, 8000, 16000, 32000, 40000]);
  });
  it("never above the account quota, never below day 0 before the start", () => {
    expect(rampCapFor(new Date("2026-12-31T00:00:00Z"), 1000)).toBe(800);
    expect(rampCapFor(new Date("2026-11-01T00:00:00Z"), 50000)).toBe(500);
  });
});

describe("marketingRampAllows", () => {
  beforeEach(() => {
    resetMarketingRampForTests();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  const day0 = new Date("2026-11-19T10:00:00Z");

  it("allows until today's cap, counting from the DB once then in memory", async () => {
    counted.n = 498;
    expect(await marketingRampAllows(day0)).toBe(true);
    expect(await marketingRampAllows(day0)).toBe(true);
    expect(await marketingRampAllows(day0)).toBe(false);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("re-reads the count on a new UTC day", async () => {
    counted.n = 500;
    expect(await marketingRampAllows(day0)).toBe(false);
    counted.n = 0;
    expect(await marketingRampAllows(new Date("2026-11-20T00:05:00Z"))).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("fails loud when SES's quota cannot be read", async () => {
    counted.n = 0;
    vi.mocked(awsRequest).mockResolvedValueOnce({ status: 403, text: "denied" });
    await expect(marketingRampAllows(day0)).rejects.toThrow(/GetAccount 403/);
  });
});
