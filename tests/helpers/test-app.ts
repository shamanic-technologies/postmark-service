import express from "express";
import path from "path";
import fs from "fs";
import { apiKeyAuth, requireOrgId } from "../../src/middleware/serviceAuth";
import healthRoutes from "../../src/routes/health";
import sendRoutes from "../../src/routes/send";
import statusRoutes from "../../src/routes/status";
import webhooksRoutes from "../../src/routes/webhooks";
import performanceRoutes from "../../src/routes/performance";

/**
 * Create a test Express app instance
 */
export function createTestApp() {
  const app = express();

  app.use(express.json());

  // ── Public (no auth) ──────────────────────────────────────────────────────
  app.use("/", healthRoutes);

  // OpenAPI spec endpoint
  app.get("/openapi.json", (req, res) => {
    const specPath = path.resolve(__dirname, "../../openapi.json");
    if (fs.existsSync(specPath)) {
      const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
      res.json(spec);
    } else {
      res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
    }
  });

  // Webhooks — no auth
  app.use("/webhooks", webhooksRoutes);

  // ── Public (API key only) ─────────────────────────────────────────────────
  app.use("/public", apiKeyAuth, performanceRoutes);

  // ── Internal (API key only) ───────────────────────────────────────────────
  app.use("/internal", apiKeyAuth, statusRoutes.internal);

  // ── Org-scoped (API key + x-org-id required) ─────────────────────────────
  app.use("/orgs", apiKeyAuth, requireOrgId, sendRoutes);
  app.use("/orgs", apiKeyAuth, requireOrgId, statusRoutes.orgs);

  return app;
}

/**
 * Get auth headers for authenticated requests (org-scoped)
 */
export function getAuthHeaders(overrides?: { orgId?: string; userId?: string; runId?: string }) {
  return {
    "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
    "Content-Type": "application/json",
    "x-org-id": overrides?.orgId || "test-org-id",
    "x-user-id": overrides?.userId || "test-user-id",
    "x-run-id": overrides?.runId || "test-run-id",
  };
}

/**
 * Get auth headers for internal/public requests (API key only)
 */
export function getServiceHeaders() {
  return {
    "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
    "Content-Type": "application/json",
  };
}
