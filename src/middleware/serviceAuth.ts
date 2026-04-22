import { Request, Response, NextFunction } from "express";

/**
 * API key authentication middleware.
 * Validates X-API-Key header against the configured service secret.
 * Crashes at startup if the env var is missing.
 */
const validSecret = process.env.POSTMARK_SERVICE_API_KEY || process.env.SERVICE_SECRET_KEY;
if (!validSecret && process.env.NODE_ENV !== "test") {
  console.error("[postmark-service] POSTMARK_SERVICE_API_KEY not configured — refusing to start");
  process.exit(1);
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.POSTMARK_SERVICE_API_KEY || process.env.SERVICE_SECRET_KEY;
  if (!secret) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({
      error: "Missing API key",
      message: "Please provide X-API-Key header",
    });
  }

  if (apiKey !== secret) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}

export interface OrgContext {
  orgId: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

declare global {
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

/**
 * Require x-org-id header. Parses all identity headers but only requires orgId.
 * Must be used AFTER apiKeyAuth.
 */
export function requireOrgId(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-org-id" });
  }

  req.orgContext = {
    orgId,
    userId: typeof req.headers["x-user-id"] === "string" ? req.headers["x-user-id"] : undefined,
    runId: typeof req.headers["x-run-id"] === "string" ? req.headers["x-run-id"] : undefined,
    campaignId: typeof req.headers["x-campaign-id"] === "string" ? req.headers["x-campaign-id"] : undefined,
    brandId: typeof req.headers["x-brand-id"] === "string" ? req.headers["x-brand-id"] : undefined,
    featureSlug: typeof req.headers["x-feature-slug"] === "string" ? req.headers["x-feature-slug"] : undefined,
    workflowSlug: typeof req.headers["x-workflow-slug"] === "string" ? req.headers["x-workflow-slug"] : undefined,
  };

  next();
}
