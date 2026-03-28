/**
 * HTTP client for resolving dynasty slugs to versioned slugs
 * via features-service and workflow-service.
 */

function getFeaturesServiceUrl(): string {
  return process.env.FEATURES_SERVICE_URL || "http://localhost:3009";
}
function getFeaturesServiceApiKey(): string {
  return process.env.FEATURES_SERVICE_API_KEY || "";
}

function getWorkflowServiceUrl(): string {
  return process.env.WORKFLOW_SERVICE_URL || "http://localhost:3002";
}
function getWorkflowServiceApiKey(): string {
  return process.env.WORKFLOW_SERVICE_API_KEY || "";
}

// ─── Feature dynasty resolution ──────────────────────────────────────────────

export async function resolveFeatureDynastySlugs(
  dynastySlug: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<string[]> {
  const url = `${getFeaturesServiceUrl()}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": getFeaturesServiceApiKey(),
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[postmark-service] features-service GET /features/dynasty/slugs failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { slugs: string[] };
  return data.slugs;
}

// ─── Feature dynasties (all) ─────────────────────────────────────────────

interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

export async function fetchAllFeatureDynasties(
  headers: { orgId: string; userId: string; runId: string },
): Promise<DynastyEntry[]> {
  const url = `${getFeaturesServiceUrl()}/features/dynasties`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": getFeaturesServiceApiKey(),
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[postmark-service] features-service GET /features/dynasties failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { dynasties: DynastyEntry[] };
  return data.dynasties;
}

// ─── Workflow dynasty resolution ─────────────────────────────────────────────

export async function resolveWorkflowDynastySlugs(
  dynastySlug: string,
  headers: { orgId: string; userId: string; runId: string },
): Promise<string[]> {
  const url = `${getWorkflowServiceUrl()}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": getWorkflowServiceApiKey(),
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[postmark-service] workflow-service GET /workflows/dynasty/slugs failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { slugs: string[] };
  return data.slugs;
}

// ─── Workflow dynasties (all) ────────────────────────────────────────────

export async function fetchAllWorkflowDynasties(
  headers: { orgId: string; userId: string; runId: string },
): Promise<DynastyEntry[]> {
  const url = `${getWorkflowServiceUrl()}/workflows/dynasties`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-API-Key": getWorkflowServiceApiKey(),
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[postmark-service] workflow-service GET /workflows/dynasties failed: ${response.status} - ${errorText}`,
    );
  }

  const data = (await response.json()) as { dynasties: DynastyEntry[] };
  return data.dynasties;
}

// ─── Reverse map builder ─────────────────────────────────────────────────

export function buildSlugToDynastyMap(dynasties: DynastyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}
