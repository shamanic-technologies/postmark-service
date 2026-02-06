import express from "express";
import path from "path";
import fs from "fs";
import { serviceAuth } from "../../src/middleware/serviceAuth";
import healthRoutes from "../../src/routes/health";
import sendRoutes from "../../src/routes/send";
import statusRoutes from "../../src/routes/status";
import webhooksRoutes from "../../src/routes/webhooks";

/**
 * Create a test Express app instance
 */
export function createTestApp() {
  const app = express();

  app.use(express.json());
  app.use(serviceAuth);

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

  app.use("/", healthRoutes);
  app.use("/", sendRoutes);
  app.use("/", statusRoutes);
  app.use("/", webhooksRoutes);

  return app;
}

/**
 * Get auth headers for authenticated requests
 */
export function getAuthHeaders() {
  return {
    "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
    "Content-Type": "application/json",
  };
}
