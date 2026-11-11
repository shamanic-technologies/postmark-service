import {
  createRun,
  updateRun,
  addCosts,
  createPlatformRun,
  updatePlatformRun,
  addPlatformCosts,
  CostItem,
  RunSupport,
} from "./runs-client";
import type { Payer } from "./payer";

/**
 * The run + cost ledger for one send, opened against whoever pays for it.
 *
 * Both branches declare the same run (`postmark-service` / `email-send`) and the
 * same cost (`postmark-email-send`, priced by costs-service, `costSource` = the
 * key that actually paid Postmark). The only difference is the ORG on the run:
 *
 * - org payer      → `POST /v1/runs` with the org's identity headers. The cost row
 *                    carries `organization_id`, so billing charges the org.
 * - platform payer → `POST /v1/platform-runs` with no org at all. The cost row
 *                    carries a NULL org, so no org-spend SUM can reach it.
 *
 * Neither branch is allowed to be silent: every call fails loud, exactly as the
 * org-run path always has. A send whose spend cannot be declared does not happen.
 */
export interface SendLedger {
  runId: string;
  /**
   * `idempotencyKey` makes a replay (catch-up after a lost answer) return the
   * original cost row instead of writing a second one.
   */
  addSendCost(costSource: "platform" | "org", idempotencyKey?: string): Promise<void>;
  complete(): Promise<void>;
  fail(error?: string): Promise<void>;
}

export interface OpenSendLedgerParams {
  payer: Payer;
  orgId: string;
  userId: string;
  parentRunId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
  /** Set when the send names nobody: the run is support from creation (see send-support.ts). */
  support?: RunSupport;
  trackingHeaders: Record<string, string>;
}

export async function openSendLedger(
  params: OpenSendLedgerParams
): Promise<SendLedger> {
  const { payer, orgId, userId, trackingHeaders } = params;

  if (payer === "platform") {
    return openPlatformSendLedger(trackingHeaders, params.support);
  }

  const run = await createRun(
    {
      orgId,
      serviceName: "postmark-service",
      taskName: "email-send",
      parentRunId: params.parentRunId,
      userId,
      brandId: params.brandId,
      campaignId: params.campaignId,
      featureSlug: params.featureSlug,
      workflowSlug: params.workflowSlug,
      audienceId: params.audienceId,
      ...(params.support ? { support: params.support } : {}),
    },
    trackingHeaders
  );
  return attachSendLedger({ runId: run.id, payer, orgId, userId, trackingHeaders });
}

export interface AttachSendLedgerParams {
  runId: string;
  payer: Payer;
  orgId: string | null;
  userId: string | null;
  trackingHeaders: Record<string, string>;
}

/**
 * The ledger of a run that is ALREADY open: what settles a send after its
 * response, inline or from the catch-up sweep, rebuilt from the sending row.
 */
export function attachSendLedger(params: AttachSendLedgerParams): SendLedger {
  const { runId, trackingHeaders } = params;
  if (params.payer === "platform") return platformLedger(runId, trackingHeaders);
  const { orgId, userId } = params;
  if (!orgId) throw new Error(`org-paid send run ${runId} has no org_id`);
  return {
    runId,
    addSendCost: async (costSource, idempotencyKey) => {
      await addCosts(
        runId,
        [{ costName: "postmark-email-send", quantity: 1, costSource, ...(idempotencyKey ? { idempotencyKey } : {}) }],
        orgId,
        userId ?? "",
        trackingHeaders
      );
    },
    complete: async () => {
      await updateRun(runId, "completed", orgId, userId ?? "", undefined, trackingHeaders);
    },
    fail: async (error?: string) => {
      await updateRun(runId, "failed", orgId, userId ?? "", error, trackingHeaders);
    },
  };
}

/**
 * The platform branch on its own: an ORG-LESS platform run (`POST
 * /v1/platform-runs`, no `x-org-id` / `x-user-id`) carrying the same
 * `postmark-email-send` cost every send declares. `openSendLedger` uses it for a
 * platform-paid send, and `POST /internal/platform-send` uses it directly, because
 * a send made before any organization exists has no org to pass at all.
 */
export async function openPlatformSendLedger(
  trackingHeaders: Record<string, string> = {},
  support?: RunSupport
): Promise<SendLedger> {
  const run = await createPlatformRun(
    { serviceName: "postmark-service", taskName: "email-send", ...(support ? { support } : {}) },
    trackingHeaders
  );
  return platformLedger(run.id, trackingHeaders);
}

function platformLedger(runId: string, trackingHeaders: Record<string, string>): SendLedger {
  return {
    runId,
    addSendCost: async (costSource, idempotencyKey) => {
      await addPlatformCosts(
        runId,
        [{ costName: "postmark-email-send", quantity: 1, costSource, ...(idempotencyKey ? { idempotencyKey } : {}) }],
        trackingHeaders
      );
    },
    complete: async () => {
      await updatePlatformRun(runId, "completed", undefined, trackingHeaders);
    },
    fail: async (error?: string) => {
      await updatePlatformRun(runId, "failed", error, trackingHeaders);
    },
  };
}

export type { CostItem };
