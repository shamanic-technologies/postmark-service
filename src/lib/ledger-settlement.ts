import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { messageOf } from "./db-error.js";
import { RunsHttpError } from "./runs-client";
import { attachSendLedger } from "./send-ledger";
import { catchUpOwedDeclarations, declareSendOutcome, OwedDeclaration } from "./outcome-declaration";
import type { Payer } from "./payer";

/**
 * The run ledger of a send, settled AFTER the send answered its caller
 * (SIGNUP-EMAILS-1111).
 *
 * A send's caller needs one fact: did Postmark accept the message. Declaring the
 * cost and completing the run on runs-service took up to 15 s in prod (2026-11-11,
 * welcome mail of info@zenotris.com: Postmark accepted at +0.9 s, the run completed
 * at +15.7 s), so email-gateway gave up at 10 s and retried, and the person got the
 * mail twice. The run is still OPENED before the provider call (its id is on the
 * sending row and a send whose run cannot be opened does not happen); only its
 * settlement moves here.
 *
 * Never dropped: the sending row records what the run still owes (`ledger_status`,
 * `ledger_cost_source`) in the same INSERT that records the send, so a crash or a
 * runs-service outage leaves the row owed and the catch-up sweep settles it. The
 * cost carries a per-send idempotency key, so a replay after a lost answer returns
 * the original cost row, never a second charge. A 4xx refusal cannot succeed on
 * retry: stored on the row, logged loud, not retried.
 *
 * The outcome declaration (message_sent) follows the settlement, so the run holds
 * its cost before it holds its outcome, as it did when both ran inline.
 */

export type LedgerStatus = "completed" | "failed";

export interface OwedLedger {
  sendingId: string;
  runId: string;
  payer: Payer;
  orgId: string | null;
  userId: string | null;
  status: LedgerStatus;
  costSource: "platform" | "org" | null;
  /** Postmark's refusal, carried onto a failed run. */
  error: string | null;
  trackingHeaders: Record<string, string>;
}

/** Per-send cost key: one send = one cost row, whatever the number of replays. */
export function sendCostIdempotencyKey(sendingId: string): string {
  return `postmark-email-send:${sendingId}`;
}

/** The tracking headers a send's ledger calls carried, rebuilt from the sending row. */
export function trackingHeadersOf(row: {
  campaignId: string | null;
  brandIds: string[] | null;
  featureSlug: string | null;
  workflowSlug: string | null;
  audienceId: string | null;
}): Record<string, string> {
  const h: Record<string, string> = {};
  if (row.campaignId) h["x-campaign-id"] = row.campaignId;
  if (row.brandIds && row.brandIds.length > 0) h["x-brand-id"] = row.brandIds.join(",");
  if (row.featureSlug) h["x-feature-slug"] = row.featureSlug;
  if (row.workflowSlug) h["x-workflow-slug"] = row.workflowSlug;
  if (row.audienceId) h["x-audience-id"] = row.audienceId;
  return h;
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

/** Settle one send's run and record the result on its row. Never throws. Returns true once settled. */
export async function settleSendLedger(owed: OwedLedger): Promise<boolean> {
  try {
    const ledger = attachSendLedger({
      runId: owed.runId,
      payer: owed.payer,
      orgId: owed.orgId,
      userId: owed.userId,
      trackingHeaders: owed.trackingHeaders,
    });
    if (owed.status === "completed") {
      if (!owed.costSource) throw new Error("completed send has no ledger_cost_source");
      await ledger.addSendCost(owed.costSource, sendCostIdempotencyKey(owed.sendingId));
      await ledger.complete();
    } else {
      await ledger.fail(owed.error ?? undefined);
    }
  } catch (err) {
    const reason = messageOf(err);
    if (isPermanentRefusal(err)) {
      console.error(
        `[ledger-settlement] REFUSED, not retried — sending=${owed.sendingId} run=${owed.runId} status=${owed.status} error="${reason}"`
      );
      await markRow(owed.sendingId, { ledgerSettleError: reason.slice(0, 1000) });
    } else {
      console.error(
        `[ledger-settlement] FAILED, owed and retried by catch-up — sending=${owed.sendingId} run=${owed.runId} status=${owed.status} error="${reason}"`
      );
    }
    return false;
  }
  await markRow(owed.sendingId, { ledgerSettledAt: new Date() });
  return true;
}

async function markRow(
  sendingId: string,
  set: { ledgerSettledAt?: Date; ledgerSettleError?: string }
): Promise<void> {
  try {
    await db.update(postmarkSendings).set(set).where(eq(postmarkSendings.id, sendingId));
  } catch (err) {
    // The settlement itself landed (or was refused); a lost mark only means the
    // catch-up replays it: the cost key returns the original row, completing a
    // completed run is a no-op status write.
    console.error(`[ledger-settlement] could not mark sending=${sendingId} — error="${messageOf(err)}"`);
  }
}

/**
 * Settle a send that just answered its caller, off the request path; then
 * declare its outcome (if it named one), then sweep anything still owed.
 */
export function scheduleLedgerSettlement(owed: OwedLedger, outcome: OwedDeclaration | null): void {
  void (async () => {
    const settled = await settleSendLedger(owed);
    // A send whose ledger is still owed declares its outcome from the catch-up,
    // once settled (outcome-declaration waits on ledger_settled_at).
    if (settled && outcome) await declareSendOutcome(outcome);
    await catchUpOwedLedgers();
    await catchUpOwedDeclarations();
  })();
}

// ─── Catch-up ────────────────────────────────────────────────────────────────
//
// No timer: an idle service queries nothing (repo rule). The catch-up runs after a
// send settles, at most once a minute, and once ~60 s after boot. A row is left
// to its own inline settlement for GRACE_MS before the sweep touches it.

const CATCH_UP_INTERVAL_MS = 60_000;
const GRACE_MS = 2 * 60_000;
const OWED_WINDOW_DAYS = 30;
const CATCH_UP_BATCH = 200;

let catchUpRunning = false;
let lastCatchUpAt = 0;

export function resetLedgerCatchUpStateForTests(): void {
  catchUpRunning = false;
  lastCatchUpAt = 0;
}

export async function catchUpOwedLedgers(now: number = Date.now()): Promise<number> {
  if (catchUpRunning || now - lastCatchUpAt < CATCH_UP_INTERVAL_MS) return 0;
  catchUpRunning = true;
  lastCatchUpAt = now;
  try {
    const rows = await db
      .select()
      .from(postmarkSendings)
      .where(
        and(
          isNotNull(postmarkSendings.ledgerStatus),
          isNull(postmarkSendings.ledgerSettledAt),
          isNull(postmarkSendings.ledgerSettleError),
          lt(postmarkSendings.createdAt, new Date(now - GRACE_MS)),
          gt(postmarkSendings.createdAt, sql`now() - make_interval(days => ${OWED_WINDOW_DAYS})`)
        )
      )
      .orderBy(asc(postmarkSendings.createdAt))
      .limit(CATCH_UP_BATCH);

    let settled = 0;
    for (const r of rows) {
      if (!r.runId) continue;
      const ok = await settleSendLedger({
        sendingId: r.id,
        runId: r.runId,
        payer: r.payer as Payer,
        orgId: r.orgId,
        userId: r.userId,
        status: r.ledgerStatus as LedgerStatus,
        costSource: r.ledgerCostSource as "platform" | "org" | null,
        error: r.message,
        trackingHeaders: trackingHeadersOf(r),
      });
      if (ok) settled++;
    }
    if (rows.length > 0) {
      console.log(`[ledger-settlement] catch-up settled ${settled}/${rows.length} owed send ledger(s)`);
    }
    return rows.length;
  } catch (err) {
    console.error(`[ledger-settlement] catch-up failed — error="${messageOf(err)}"`);
    return 0;
  } finally {
    catchUpRunning = false;
  }
}
