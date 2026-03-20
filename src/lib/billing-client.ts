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
function getCostsServiceUrl(): string {
  return process.env.COSTS_SERVICE_URL || "http://localhost:3011";
}
function getCostsServiceApiKey(): string {
  return process.env.COSTS_SERVICE_API_KEY || "";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthorizeResult {
  sufficient: boolean;
  balance_cents: number | null;
  billing_mode: string;
}

interface PlatformPrice {
  name: string;
  pricePerUnitInUsdCents: string;
  provider: string;
  effectiveFrom: string;
}

// ─── Cost estimation ────────────────────────────────────────────────────────

let cachedUnitCostCents: number | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FALLBACK_COST_CENTS = 1; // 1 cent fallback if costs-service is unavailable

export function _clearCostCache(): void {
  cachedUnitCostCents = null;
  cacheExpiresAt = 0;
}

async function getUnitCostCents(
  orgId: string,
  userId: string,
  runId: string,
  trackingHeaders: Record<string, string> = {}
): Promise<number> {
  if (cachedUnitCostCents !== null && Date.now() < cacheExpiresAt) {
    return cachedUnitCostCents;
  }

  try {
    const response = await fetch(
      `${getCostsServiceUrl()}/v1/platform-prices/postmark-email-send`,
      {
        method: "GET",
        headers: {
          "X-API-Key": getCostsServiceApiKey(),
          "x-org-id": orgId,
          "x-user-id": userId,
          "x-run-id": runId,
          ...trackingHeaders,
        },
      }
    );

    if (!response.ok) {
      console.warn(
        `[billing] Failed to fetch unit cost from costs-service: ${response.status} — using fallback ${FALLBACK_COST_CENTS}c`
      );
      return FALLBACK_COST_CENTS;
    }

    const price = (await response.json()) as PlatformPrice;
    cachedUnitCostCents = Math.ceil(parseFloat(price.pricePerUnitInUsdCents));
    if (cachedUnitCostCents < 1) cachedUnitCostCents = 1;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return cachedUnitCostCents;
  } catch (error: any) {
    console.warn(
      `[billing] costs-service unreachable: ${error.message} — using fallback ${FALLBACK_COST_CENTS}c`
    );
    return FALLBACK_COST_CENTS;
  }
}

// ─── Authorization ──────────────────────────────────────────────────────────

export async function authorizeCredits(params: {
  orgId: string;
  userId: string;
  runId: string;
  emailCount: number;
  trackingHeaders?: Record<string, string>;
}): Promise<AuthorizeResult> {
  const { orgId, userId, runId, emailCount, trackingHeaders = {} } = params;

  const unitCost = await getUnitCostCents(orgId, userId, runId, trackingHeaders);
  const requiredCents = unitCost * emailCount;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": getBillingServiceApiKey(),
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    ...trackingHeaders,
  };

  const response = await fetch(`${getBillingServiceUrl()}/v1/credits/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      required_cents: requiredCents,
      description: `postmark-email-send × ${emailCount}`,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `billing-service POST /v1/credits/authorize failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<AuthorizeResult>;
}
