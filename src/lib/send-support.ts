import { sql } from "drizzle-orm";
import { db } from "../db";
import { markOwnRunsSupport, RunSupport, SupportSelectionResult } from "./runs-client";
import type { OutcomeSubject } from "./outcome-declaration";

/**
 * Spend of a send that names nobody is SUPPORT, never production
 * (LEDGER-HISTORY-1024, agent-config skill `cost-accounting`).
 *
 * One rule for every send, no tag or slug read: a send whose caller named the
 * person it reached produced `message_sent` for them (outcome-declaration.ts); a
 * send naming nobody (a receipt, a sign-up code, a lifecycle notification, a
 * staff alert) produces no outcome by design, so its run is marked support,
 * function `product_feature`. The mark is set at run creation, so the run never
 * reads "undeclared".
 *
 * Measured before shipping (prod 2026-10-24): of every send run since inception,
 * none that named nobody rode a declared ancestor since the subject threading
 * shipped; the ones that ride a caller's outcome today (newsletter releases
 * declared by transactional-email-service before senders named subjects) are
 * left as they are by the backfill (`offOutcomeOnly`).
 */
export const SEND_SUPPORT: RunSupport = {
  kind: "product_feature",
  reason:
    "postmark-service send naming no outcome subject (receipt, code, lifecycle notification, staff alert): produces no outcome by design",
};

export function sendSupportFor(subject: OutcomeSubject | null): RunSupport | undefined {
  return subject ? undefined : SEND_SUPPORT;
}

export const BACKFILL_MARKED_BY = "postmark-service LEDGER-HISTORY-1024 backfill";
const RUN_IDS_PER_CALL = 5000;

export interface SupportBackfillReport {
  /** First send that named a subject: before it, no send of this service could. */
  cutover: string;
  beforeCutover: SupportSelectionResult;
  afterCutover: { runIds: number; batches: SupportSelectionResult[] };
  applied: boolean;
}

/**
 * Marks SUPPORT every past send run of this service that named nobody and rides
 * no outcome. Built from this service's own records, idempotent (runs-service
 * keeps a run's first mark and refuses a run that declared an outcome).
 *
 * - Before the first send that named a subject (`cutover`, read from
 *   postmark_sendings), no send of this service could name one: every run then
 *   is a send naming nobody. Selected by runs-service over our runs with spend,
 *   leaving out any whose cost rides an ancestor's outcome today.
 * - From the cutover on, the runs of our own successful sends that named nobody.
 *   A batch whose preview says a run rides an ancestor's outcome is refused
 *   (fail loud): the mark would take that cost off production.
 *
 * Failed sends are not touched: a run that produced nothing stays a run with no
 * output.
 */
export async function backfillSendSupportMarks(apply: boolean): Promise<SupportBackfillReport> {
  const { rows: cutoverRows } = await db.execute<{ cutover: Date | string | null }>(
    sql`SELECT min(created_at) AS cutover FROM postmark_sendings WHERE outcome_subject_id IS NOT NULL`
  );
  const rawCutover = cutoverRows[0]?.cutover;
  if (!rawCutover) throw new Error("no send has named an outcome subject yet: cutover unknown");
  const cutover = new Date(rawCutover).toISOString();

  const mark = { ...SEND_SUPPORT, markedBy: BACKFILL_MARKED_BY };
  const beforeBody = {
    ...mark,
    taskNames: ["email-send"],
    startedBefore: cutover,
    withSpendOnly: true,
    offOutcomeOnly: true,
  };
  const beforeCutover = await markOwnRunsSupport("preview", beforeBody);
  if (beforeCutover.tooMany) throw new Error(`before-cutover selection too large: ${JSON.stringify(beforeCutover)}`);
  if (apply && beforeCutover.toMarkCount > 0) await markOwnRunsSupport("apply", beforeBody);

  const { rows: after } = await db.execute<{ run_id: string }>(sql`
    SELECT DISTINCT run_id FROM postmark_sendings
    WHERE created_at >= ${cutover}::timestamptz AND error_code = 0
      AND outcome_subject_id IS NULL AND run_id IS NOT NULL
    ORDER BY run_id
  `);
  const runIds = after.map((r) => r.run_id);

  const batches: SupportSelectionResult[] = [];
  for (let i = 0; i < runIds.length; i += RUN_IDS_PER_CALL) {
    const body = { ...mark, runIds: runIds.slice(i, i + RUN_IDS_PER_CALL) };
    const preview = await markOwnRunsSupport("preview", body);
    if (preview.onOutcomeNowCount !== 0) {
      throw new Error(
        `refused: ${preview.onOutcomeNowCount ?? "unknown"} run(s) of this batch ride an ancestor's outcome today; marking them would take that cost off production`
      );
    }
    batches.push(preview);
    if (apply && preview.toMarkCount > 0) await markOwnRunsSupport("apply", body);
  }

  return { cutover, beforeCutover, afterCutover: { runIds: runIds.length, batches }, applied: apply };
}
