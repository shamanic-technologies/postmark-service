import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("../../src/lib/runs-client", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/runs-client")>(
    "../../src/lib/runs-client"
  );
  return {
    ...actual,
    addCosts: vi.fn().mockResolvedValue({ costs: [] }),
    updateRun: vi.fn().mockResolvedValue({}),
    addPlatformCosts: vi.fn().mockResolvedValue({ costs: [] }),
    updatePlatformRun: vi.fn().mockResolvedValue({}),
  };
});

import { db } from "../../src/db";
import { postmarkSendings } from "../../src/db/schema";
import { addPlatformCosts, updatePlatformRun, updateRun } from "../../src/lib/runs-client";
import { catchUpOwedLedgers, resetLedgerCatchUpStateForTests } from "../../src/lib/ledger-settlement";
import { cleanTestData, closeDb, randomUUID } from "../helpers/test-db";

async function insertSend(ageMinutes: number, extra: Partial<typeof postmarkSendings.$inferInsert> = {}) {
  const [row] = await db
    .insert(postmarkSendings)
    .values({
      messageId: randomUUID(),
      toEmail: "new-client@example.com",
      fromEmail: "hello@test.com",
      orgId: "org-1",
      runId: randomUUID(),
      errorCode: 0,
      payer: "platform",
      ledgerStatus: "completed",
      ledgerCostSource: "platform",
      createdAt: sql`now() - make_interval(mins => ${ageMinutes})` as any,
      ...extra,
    })
    .returning();
  return row;
}

describe("catch-up of owed send ledgers (SIGNUP-EMAILS-1111)", () => {
  beforeEach(async () => {
    await cleanTestData();
    resetLedgerCatchUpStateForTests();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("settles owed rows past the grace window, once, and marks them", async () => {
    const owed = await insertSend(10);
    const fresh = await insertSend(0);
    const inline = await insertSend(10, { ledgerStatus: null, ledgerCostSource: null });
    const failed = await insertSend(10, { ledgerStatus: "failed", ledgerCostSource: null, payer: "org", message: "Inactive recipient" });

    expect(await catchUpOwedLedgers(Date.now())).toBe(2);
    expect(addPlatformCosts).toHaveBeenCalledWith(
      owed.runId,
      [expect.objectContaining({ idempotencyKey: `postmark-email-send:${owed.id}` })],
      {}
    );
    expect(updatePlatformRun).toHaveBeenCalledWith(owed.runId, "completed", undefined, {});
    expect(updateRun).toHaveBeenCalledWith(failed.runId, "failed", "org-1", "", "Inactive recipient", {});

    const read = async (id: string) =>
      (await db.select().from(postmarkSendings).where(eq(postmarkSendings.id, id)))[0];
    expect((await read(owed.id)).ledgerSettledAt).not.toBeNull();
    expect((await read(failed.id)).ledgerSettledAt).not.toBeNull();
    expect((await read(fresh.id)).ledgerSettledAt).toBeNull();
    expect((await read(inline.id)).ledgerSettledAt).toBeNull();

    resetLedgerCatchUpStateForTests();
    expect(await catchUpOwedLedgers(Date.now())).toBe(0);
  });

  it("leaves a refused row alone", async () => {
    await insertSend(10, { ledgerSettleError: "404 Run not found" });
    expect(await catchUpOwedLedgers(Date.now())).toBe(0);
    expect(addPlatformCosts).not.toHaveBeenCalled();
  });
});
