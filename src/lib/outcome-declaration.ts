import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { messageOf } from "./db-error.js";
import {
  addOutcomes,
  addPlatformOutcomes,
  OutcomeDeclaration,
  RunsHttpError,
} from "./runs-client";
import type { Payer } from "./payer";

/**
 * The outcome a send PRODUCES, declared on its own send run to runs-service's
 * production-cost ledger (COST-ACCOUNTING-1023, agent-config skill `cost-accounting`).
 *
 * One mechanism for every send: a send that names the person it reached (an
 * outcome subject) produced `message_sent` for that person; a send that names
 * nobody (a receipt, a sign-up code, a staff alert: support functions) declares
 * nothing and its cost reads "produced none". This service cannot tell a
 * newsletter from a receipt by itself, and must not try with a tag or slug list:
 * only the caller knows it is mailing one person on a list or campaign, so the
 * caller names the subject, exactly as it names the payer.
 *
 * Subject = the person as the fleet knows them: `{subjectService, subjectId}`
 * stated by the caller, or, when the caller sent only `leadId`, the lead in
 * lead-service. Never invented here.
 *
 * Never blocks or fails the send: the declaration runs after the send has
 * succeeded and been recorded, off the request path. A failure is logged loud
 * and the row stays owed (`outcome_declared_at` NULL); the catch-up sweep
 * re-declares owed rows, and runs-service's idempotency makes a replay
 * `already_recorded`, never a second occurrence. A 4xx refusal (unknown outcome
 * key, run of another org) cannot succeed on retry: it is stored on the row and
 * logged, not retried.
 */

export const MESSAGE_SENT = "message_sent";
export const LEAD_SERVICE = "lead-service";

export interface OutcomeSubject {
  subjectService: string;
  subjectId: string;
}

export function resolveOutcomeSubject(input: {
  outcomeSubject?: OutcomeSubject;
  leadId?: string;
}): OutcomeSubject | null {
  if (input.outcomeSubject) return input.outcomeSubject;
  if (input.leadId) return { subjectService: LEAD_SERVICE, subjectId: input.leadId };
  return null;
}

export function buildSendDeclaration(
  subject: OutcomeSubject,
  consumedOutcomeKeys: string[] | null | undefined
): OutcomeDeclaration {
  return {
    produced: [{ outcomeKey: MESSAGE_SENT, ...subject }],
    consumed: (consumedOutcomeKeys ?? []).map((outcomeKey) => ({ outcomeKey, ...subject })),
  };
}

export interface OwedDeclaration {
  sendingId: string;
  runId: string;
  payer: Payer;
  orgId: string | null;
  subjectService: string;
  subjectId: string;
  consumedOutcomeKeys: string[] | null;
}

function isPermanentRefusal(err: unknown): boolean {
  return (
    err instanceof RunsHttpError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429
  );
}

/** Declare one send's outcome and record the result on its row. Never throws. */
export async function declareSendOutcome(owed: OwedDeclaration): Promise<void> {
  const declaration = buildSendDeclaration(
    { subjectService: owed.subjectService, subjectId: owed.subjectId },
    owed.consumedOutcomeKeys
  );
  try {
    if (owed.payer === "platform") {
      await addPlatformOutcomes(owed.runId, declaration);
    } else {
      if (!owed.orgId) throw new Error("org-paid send has no org_id");
      await addOutcomes(owed.runId, declaration, owed.orgId);
    }
  } catch (err) {
    const reason = messageOf(err);
    if (isPermanentRefusal(err)) {
      console.error(
        `[outcome-declaration] REFUSED, not retried — sending=${owed.sendingId} run=${owed.runId} subject=${owed.subjectService}/${owed.subjectId} error="${reason}"`
      );
      await markRow(owed.sendingId, { outcomeDeclareError: reason.slice(0, 1000) });
    } else {
      console.error(
        `[outcome-declaration] FAILED, owed and retried by catch-up — sending=${owed.sendingId} run=${owed.runId} subject=${owed.subjectService}/${owed.subjectId} error="${reason}"`
      );
    }
    return;
  }
  await markRow(owed.sendingId, { outcomeDeclaredAt: new Date() });
}

async function markRow(
  sendingId: string,
  set: { outcomeDeclaredAt?: Date; outcomeDeclareError?: string }
): Promise<void> {
  try {
    await db.update(postmarkSendings).set(set).where(eq(postmarkSendings.id, sendingId));
  } catch (err) {
    // The declaration itself landed (or was refused); a lost mark only means the
    // catch-up replays it, which runs-service answers `already_recorded`.
    console.error(
      `[outcome-declaration] could not mark sending=${sendingId} — error="${messageOf(err)}"`
    );
  }
}

/**
 * Fire the declaration for a send that just succeeded, off the request path,
 * then let the catch-up settle anything still owed.
 */
export function scheduleOutcomeDeclaration(owed: OwedDeclaration): void {
  void declareSendOutcome(owed).then(() => catchUpOwedDeclarations());
}

// ─── Catch-up ────────────────────────────────────────────────────────────────
//
// No timer: an idle service queries nothing (repo rule). The catch-up runs after a
// send that declared, at most once a minute, and once ~60 s after boot. A row is
// left to its own inline declaration for GRACE_MS before the sweep touches it.

const CATCH_UP_INTERVAL_MS = 60_000;
const GRACE_MS = 2 * 60_000;
const OWED_WINDOW_DAYS = 30;
const CATCH_UP_BATCH = 200;

let catchUpRunning = false;
let lastCatchUpAt = 0;

export function resetCatchUpStateForTests(): void {
  catchUpRunning = false;
  lastCatchUpAt = 0;
}

export async function catchUpOwedDeclarations(now: number = Date.now()): Promise<number> {
  if (catchUpRunning || now - lastCatchUpAt < CATCH_UP_INTERVAL_MS) return 0;
  catchUpRunning = true;
  lastCatchUpAt = now;
  try {
    const rows = await db
      .select({
        sendingId: postmarkSendings.id,
        runId: postmarkSendings.runId,
        payer: postmarkSendings.payer,
        orgId: postmarkSendings.orgId,
        subjectService: postmarkSendings.outcomeSubjectService,
        subjectId: postmarkSendings.outcomeSubjectId,
        consumedOutcomeKeys: postmarkSendings.consumedOutcomeKeys,
      })
      .from(postmarkSendings)
      .where(
        and(
          isNotNull(postmarkSendings.outcomeSubjectId),
          isNull(postmarkSendings.outcomeDeclaredAt),
          isNull(postmarkSendings.outcomeDeclareError),
          lt(postmarkSendings.createdAt, new Date(now - GRACE_MS)),
          gt(postmarkSendings.createdAt, sql`now() - make_interval(days => ${OWED_WINDOW_DAYS})`)
        )
      )
      .orderBy(asc(postmarkSendings.createdAt))
      .limit(CATCH_UP_BATCH);

    for (const r of rows) {
      if (!r.runId || !r.subjectService || !r.subjectId) continue;
      await declareSendOutcome({
        sendingId: r.sendingId,
        runId: r.runId,
        payer: r.payer as Payer,
        orgId: r.orgId,
        subjectService: r.subjectService,
        subjectId: r.subjectId,
        consumedOutcomeKeys: r.consumedOutcomeKeys,
      });
    }
    if (rows.length > 0) {
      console.log(`[outcome-declaration] catch-up re-declared ${rows.length} owed send(s)`);
    }
    return rows.length;
  } catch (err) {
    console.error(`[outcome-declaration] catch-up failed — error="${messageOf(err)}"`);
    return 0;
  } finally {
    catchUpRunning = false;
  }
}
