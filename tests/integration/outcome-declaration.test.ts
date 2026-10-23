import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("../../src/lib/runs-client", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/runs-client")>(
    "../../src/lib/runs-client"
  );
  return { ...actual, addOutcomes: vi.fn().mockResolvedValue({}), addPlatformOutcomes: vi.fn().mockResolvedValue({}) };
});

import { db } from "../../src/db";
import { postmarkSendings } from "../../src/db/schema";
import { addOutcomes } from "../../src/lib/runs-client";
import { catchUpOwedDeclarations, resetCatchUpStateForTests } from "../../src/lib/outcome-declaration";
import { cleanTestData, closeDb, randomUUID } from "../helpers/test-db";

async function insertOwed(ageMinutes: number, extra: Partial<typeof postmarkSendings.$inferInsert> = {}) {
  const [row] = await db
    .insert(postmarkSendings)
    .values({
      messageId: randomUUID(),
      toEmail: "reader@example.com",
      fromEmail: "news@test.com",
      orgId: "org-1",
      runId: randomUUID(),
      errorCode: 0,
      outcomeSubjectService: "transactional-email-service",
      outcomeSubjectId: randomUUID(),
      createdAt: sql`now() - make_interval(mins => ${ageMinutes})` as any,
      ...extra,
    })
    .returning();
  return row;
}

describe("catch-up of owed outcome declarations", () => {
  beforeEach(async () => {
    await cleanTestData();
    resetCatchUpStateForTests();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("declares owed rows past the grace window, once, and marks them", async () => {
    const owed = await insertOwed(10);
    const fresh = await insertOwed(0);
    const support = await insertOwed(10, { outcomeSubjectService: null, outcomeSubjectId: null });

    expect(await catchUpOwedDeclarations(Date.now())).toBe(1);
    expect(addOutcomes).toHaveBeenCalledWith(owed.runId, expect.objectContaining({
      produced: [{ outcomeKey: "message_sent", subjectService: "transactional-email-service", subjectId: owed.outcomeSubjectId }],
    }), "org-1");

    const [after] = await db.select().from(postmarkSendings).where(eq(postmarkSendings.id, owed.id));
    expect(after.outcomeDeclaredAt).not.toBeNull();
    const [freshAfter] = await db.select().from(postmarkSendings).where(eq(postmarkSendings.id, fresh.id));
    expect(freshAfter.outcomeDeclaredAt).toBeNull();
    const [supportAfter] = await db.select().from(postmarkSendings).where(eq(postmarkSendings.id, support.id));
    expect(supportAfter.outcomeDeclaredAt).toBeNull();

    // A second sweep finds nothing owed: no row is declared twice.
    resetCatchUpStateForTests();
    expect(await catchUpOwedDeclarations(Date.now())).toBe(0);
    expect(addOutcomes).toHaveBeenCalledTimes(1);
  });

  it("leaves a refused row alone", async () => {
    await insertOwed(10, { outcomeDeclareError: "400 unknown_outcome_key" });
    expect(await catchUpOwedDeclarations(Date.now())).toBe(0);
    expect(addOutcomes).not.toHaveBeenCalled();
  });
});
