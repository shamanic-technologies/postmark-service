import { Request, Response, NextFunction } from "express";

/**
 * Service-to-service authentication middleware
 * Validates X-Service-Secret header
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

  const serviceSecret = req.headers["x-service-secret"];
  const validSecret = process.env.POSTMARK_SERVICE_API_KEY || process.env.SERVICE_SECRET_KEY;

  if (!validSecret) {
    console.error("POSTMARK_SERVICE_API_KEY not configured in environment variables");
    return res.status(500).json({
      error: "Server configuration error",
    });
  }

  if (!serviceSecret) {
    return res.status(401).json({
      error: "Missing service secret",
      message: "Please provide X-Service-Secret header",
    });
  }

  if (serviceSecret !== validSecret) {
    return res.status(403).json({
      error: "Invalid service secret",
    });
  }

  next();
}
