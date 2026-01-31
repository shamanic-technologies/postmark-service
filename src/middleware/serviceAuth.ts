import { Request, Response, NextFunction } from "express";

/**
 * Service-to-service authentication middleware
 * Validates X-API-Key header (standard convention)
 */
export function serviceAuth(req: Request, res: Response, next: NextFunction) {
  // Skip auth for health check
  if (req.path === "/health" || req.path === "/") {
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

  next();
}
