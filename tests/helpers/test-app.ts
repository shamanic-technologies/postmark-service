import express from "express";
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
    "X-Service-Secret": process.env.SERVICE_SECRET_KEY || "test-secret-key",
    "Content-Type": "application/json",
  };
}
