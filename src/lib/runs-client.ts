/**
 * HTTP client for runs-service
 * Vendored from @mcpfactory/runs-client
 */

const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "http://localhost:3006";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  brandId: string | null;
  campaignId: string | null;
  featureSlug: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunCost {
  id: string;
  runId: string;
  costName: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  createdAt: string;
}

export interface CreateRunParams {
  orgId: string;
  userId: string;
  serviceName: string;
  taskName: string;
  parentRunId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  audienceId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function runsRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    identityHeaders?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = "GET", body, identityHeaders = {} } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
    ...identityHeaders,
  };

  const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createRun(params: CreateRunParams, trackingHeaders: Record<string, string> = {}): Promise<Run> {
  const { orgId, userId, parentRunId, ...body } = params;
  const identityHeaders: Record<string, string> = {
    "x-org-id": orgId,
    "x-user-id": userId,
    ...trackingHeaders,
  };
  if (parentRunId) {
    identityHeaders["x-run-id"] = parentRunId;
  }
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body,
    identityHeaders,
  });
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  orgId: string,
  userId: string,
  error?: string,
  trackingHeaders: Record<string, string> = {}
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status, error },
    identityHeaders: {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-run-id": runId,
      ...trackingHeaders,
    },
  });
}

export async function addCosts(
  runId: string,
  items: CostItem[],
  orgId: string,
  userId: string,
  trackingHeaders: Record<string, string> = {}
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/runs/${runId}/costs`, {
    method: "POST",
    body: { items },
    identityHeaders: {
      "x-org-id": orgId,
      "x-user-id": userId,
      "x-run-id": runId,
      ...trackingHeaders,
    },
  });
}

// ─── Platform runs (org-less spend) ──────────────────────────────────────────
//
// A platform run carries no organization, so the cost rows hung off it have
// `runs_costs.organization_id = NULL` and are invisible to
// `GET /internal/org-usage-total` — the aggregate billing-service reads to charge
// an org. That is the whole point: a platform-initiated notification must be
// declared (priced, attributable to postmark-service) without being charged to
// the org it is about.
//
// Deliberately NO `x-org-id` / `x-user-id` on these calls. runs-service accepts
// both on `/v1/platform-runs` and stores them on the row — which would put the
// cost straight back into that org's usage total. Passing them here would undo
// the fix while looking like better attribution. The recipient org stays on
// `postmark_sendings.org_id`, which is where this service records who a mail
// was for.

export interface CreatePlatformRunParams {
  serviceName: string;
  taskName: string;
}

function platformIdentityHeaders(
  trackingHeaders: Record<string, string>
): Record<string, string> {
  return { "x-service-name": "postmark-service", ...trackingHeaders };
}

export async function createPlatformRun(
  params: CreatePlatformRunParams,
  trackingHeaders: Record<string, string> = {}
): Promise<Run> {
  return runsRequest<Run>("/v1/platform-runs", {
    method: "POST",
    body: params,
    identityHeaders: platformIdentityHeaders(trackingHeaders),
  });
}

export async function updatePlatformRun(
  runId: string,
  status: "completed" | "failed",
  error?: string,
  trackingHeaders: Record<string, string> = {}
): Promise<Run> {
  return runsRequest<Run>(`/v1/platform-runs/${runId}`, {
    method: "PATCH",
    body: { status, error },
    identityHeaders: platformIdentityHeaders(trackingHeaders),
  });
}

export async function addPlatformCosts(
  runId: string,
  items: CostItem[],
  trackingHeaders: Record<string, string> = {}
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/platform-runs/${runId}/costs`, {
    method: "POST",
    body: { items },
    identityHeaders: platformIdentityHeaders(trackingHeaders),
  });
}
