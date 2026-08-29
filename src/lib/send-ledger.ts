import {
  createRun,
  updateRun,
  addCosts,
  createPlatformRun,
  updatePlatformRun,
  addPlatformCosts,
  CostItem,
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
  addSendCost(costSource: "platform" | "org"): Promise<void>;
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
  trackingHeaders: Record<string, string>;
}

export async function openSendLedger(
  params: OpenSendLedgerParams
): Promise<SendLedger> {
  const { payer, orgId, userId, trackingHeaders } = params;

  if (payer === "platform") {
    const run = await createPlatformRun(
      { serviceName: "postmark-service", taskName: "email-send" },
      trackingHeaders
    );
    return {
      runId: run.id,
      addSendCost: async (costSource) => {
        await addPlatformCosts(
          run.id,
          [{ costName: "postmark-email-send", quantity: 1, costSource }],
          trackingHeaders
        );
      },
      complete: async () => {
        await updatePlatformRun(run.id, "completed", undefined, trackingHeaders);
      },
      fail: async (error?: string) => {
        await updatePlatformRun(run.id, "failed", error, trackingHeaders);
      },
    };
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
    },
    trackingHeaders
  );
  return {
    runId: run.id,
    addSendCost: async (costSource) => {
      await addCosts(
        run.id,
        [{ costName: "postmark-email-send", quantity: 1, costSource }],
        orgId,
        userId,
        trackingHeaders
      );
    },
    complete: async () => {
      await updateRun(run.id, "completed", orgId, userId, undefined, trackingHeaders);
    },
    fail: async (error?: string) => {
      await updateRun(run.id, "failed", orgId, userId, error, trackingHeaders);
    },
  };
}

export type { CostItem };
