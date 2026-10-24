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
  /** Marks the run SUPPORT at creation (runs-service `support` on POST /v1/runs). */
  support?: RunSupport;
}

/**
 * A support function the run serves: spend that produces no outcome BY DESIGN,
 * reported apart by runs-service (cost-accounting doctrine, closed list there).
 */
export interface RunSupport {
  kind:
    | "payment_fees"
    | "brand_setup"
    | "copilot"
    | "platform_llm"
    | "staff_experiment"
    | "product_feature"
    | "retired_product";
  reason: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

/** A non-2xx answer from runs-service; `status` lets a caller tell a refusal (4xx) from an outage. */
export class RunsHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RunsHttpError";
  }
}

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
    throw new RunsHttpError(
      `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`,
      response.status
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
  support?: RunSupport;
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

// ─── Outcome occurrences (production-cost ledger) ────────────────────────────
//
// `POST /v1/runs/:id/outcomes` (org run: x-org-id must be the run's org) and
// `POST /v1/platform-runs/:id/outcomes` (org-less run: x-service-name only, for
// the same reason the platform cost calls carry no org). Idempotent per (run,
// direction, outcomeKey, subject): a replay answers `already_recorded`.

export interface OutcomeOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  quantity?: number;
}

export interface OutcomeDeclaration {
  produced: OutcomeOccurrence[];
  consumed: Omit<OutcomeOccurrence, "quantity">[];
  /**
   * Effective declaration time (runs-service COST-BACKFILL-1023-RUNS). Every rule
   * (consumption resolution, reuse rank, the day an occurrence counts on) keys on
   * it, never on when the call arrives. Absent = now.
   */
  occurredAt?: "run_started_at" | string;
}

export async function addOutcomes(
  runId: string,
  declaration: OutcomeDeclaration,
  orgId: string
): Promise<unknown> {
  return runsRequest(`/v1/runs/${runId}/outcomes`, {
    method: "POST",
    body: declaration,
    identityHeaders: { "x-org-id": orgId, "x-run-id": runId },
  });
}

export async function addPlatformOutcomes(
  runId: string,
  declaration: OutcomeDeclaration
): Promise<unknown> {
  return runsRequest(`/v1/platform-runs/${runId}/outcomes`, {
    method: "POST",
    body: declaration,
    identityHeaders: platformIdentityHeaders({}),
  });
}

// ─── Support marks on past runs (owner door) ─────────────────────────────────

export interface OwnSupportMarkRequest {
  kind: RunSupport["kind"];
  reason: string;
  markedBy: string;
  /** Exclusive with the selection fields below. */
  runIds?: string[];
  taskNames?: string[];
  startedAfter?: string;
  startedBefore?: string;
  topLevelOnly?: boolean;
  withSpendOnly?: boolean;
  offOutcomeOnly?: boolean;
  /** Leave out runs whose cost already stops on an ANCESTOR's support mark (never relabel another owner's mark). */
  offAncestorMarkOnly?: boolean;
}

export interface SupportSelectionResult {
  matchedRunCount: number;
  toMarkCount: number;
  alreadyMarkedCount: number;
  declaresOutcomesCount: number;
  onOutcomeNowCount: number | null;
  leftOnOutcomeCount: number | null;
  /** Runs to mark whose cost stops on an ancestor's support mark today (absent on a runs-service without the flag). */
  onAncestorMarkNowCount?: number | null;
  leftOnAncestorMarkCount?: number | null;
  spend: { grossCents: string; netCents: string };
  maxRuns: number;
  tooMany: boolean;
}

/**
 * Preview or apply a SUPPORT mark on this service's own past runs
 * (`POST /v1/platform-runs/support-marks/{preview,apply}`). runs-service checks
 * every run is ours, refuses a run that declared an outcome, and is idempotent.
 */
export async function markOwnRunsSupport(
  step: "preview" | "apply",
  body: OwnSupportMarkRequest
): Promise<SupportSelectionResult & Record<string, unknown>> {
  return runsRequest(`/v1/platform-runs/support-marks/${step}`, {
    method: "POST",
    body,
    identityHeaders: platformIdentityHeaders({}),
  });
}
