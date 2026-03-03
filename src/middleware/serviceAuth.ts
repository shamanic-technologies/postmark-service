import { Request, Response, NextFunction } from "express";

/**
 * Service-to-service authentication middleware
 * Validates X-API-Key header and requires x-org-id, x-user-id, and x-run-id headers
 */
export function serviceAuth(req: Request, res: Response, next: NextFunction) {
  // Skip auth for health check and OpenAPI spec
  if (req.path === "/health" || req.path === "/" || req.path === "/openapi.json") {
    return next();
  }

  // Skip auth for Postmark webhooks (they have their own verification)
  if (req.path.startsWith("/webhooks/postmark")) {
    return next();
  }

  const apiKey = req.headers["x-api-key"];
  const validSecret = process.env.POSTMARK_SERVICE_API_KEY || process.env.SERVICE_SECRET_KEY;

  if (!validSecret) {
    console.error("POSTMARK_SERVICE_API_KEY not configured in environment variables");
    return res.status(500).json({
      error: "Server configuration error",
    });
  }

  if (!apiKey) {
    return res.status(401).json({
      error: "Missing API key",
      message: "Please provide X-API-Key header",
    });
  }

  if (apiKey !== validSecret) {
    return res.status(403).json({
      error: "Invalid API key",
    });
  }

  // Require identity headers
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];

  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({
      error: "Missing required header: x-org-id",
    });
  }

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({
      error: "Missing required header: x-user-id",
    });
  }

  const runId = req.headers["x-run-id"];
  if (!runId || typeof runId !== "string") {
    return res.status(400).json({
      error: "Missing required header: x-run-id",
    });
  }

  next();
}
