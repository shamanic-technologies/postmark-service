/**
 * HTTP client for billing-service
 * Handles credit authorization before paid platform operations
 */

function getBillingServiceUrl(): string {
  return process.env.BILLING_SERVICE_URL || "http://localhost:3012";
}
function getBillingServiceApiKey(): string {
  return process.env.BILLING_SERVICE_API_KEY || "";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SalesFunnelCap {
  salesFunnelId: string;
  salesFunnelCampaignId: string;
  amountCents: number | string;
  period: string;
  consumedCents: number | string;
  reservedCents: number | string;
}

export interface AuthorizeResult {
  sufficient: boolean;
  balance_cents: number | null;
  required_cents: number;
  /**
   * Present ONLY when billing refused because a sales funnel campaign's MAX
   * BUDGET is reached (or unreadable); absent on a real balance shortfall.
   */
  reason?: string;
  sales_funnel_cap?: SalesFunnelCap;
}

// ─── Authorization ──────────────────────────────────────────────────────────

export async function authorizeCredits(params: {
  orgId: string;
  userId: string;
  runId: string;
  items: { costName: string; quantity: number }[];
  trackingHeaders?: Record<string, string>;
}): Promise<AuthorizeResult> {
  const { orgId, userId, runId, items, trackingHeaders = {} } = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": getBillingServiceApiKey(),
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    ...trackingHeaders,
  };

  const response = await fetch(`${getBillingServiceUrl()}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items,
      description: `postmark-email-send × ${items.reduce((sum, i) => sum + i.quantity, 0)}`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `billing-service POST /v1/customer_balance/authorize failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AuthorizeResult>;
}
