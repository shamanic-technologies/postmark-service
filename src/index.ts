// Load environment variables BEFORE any other imports
import * as dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { apiKeyAuth, requireOrgId } from "./middleware/serviceAuth";
import { db } from "./db";
import healthRoutes from "./routes/health";
import sendRoutes from "./routes/send";
import statusRoutes from "./routes/status";
import webhooksRoutes from "./routes/webhooks";
import performanceRoutes from "./routes/performance";

const app = express();
const PORT = process.env.PORT || 3010;

// CORS configuration
const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "https://app.pressbeat.io",
  "https://admin.pressbeat.io",
  "https://dashboard.mcpfactory.org",
  "https://mcpfactory.org",
  process.env.ALLOWED_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (service-to-service calls)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "x-org-id", "x-user-id", "x-run-id", "x-campaign-id", "x-brand-id", "x-feature-slug", "x-workflow-slug"],
  })
);

app.use(express.json());

// ── Public (no auth) ──────────────────────────────────────────────────────────
app.use("/", healthRoutes);

// OpenAPI spec endpoint
app.get("/openapi.json", (req, res) => {
  const specPath = path.resolve(__dirname, "../openapi.json");
  if (fs.existsSync(specPath)) {
    const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});

// Webhooks — no auth (Postmark calls these directly)
app.use("/webhooks", webhooksRoutes);

// ── Public (API key only) ─────────────────────────────────────────────────────
app.use("/public", apiKeyAuth, performanceRoutes);

// ── Internal (API key only) ───────────────────────────────────────────────────
app.use("/internal", apiKeyAuth, statusRoutes.internal);

// ── Org-scoped (API key + x-org-id required) ─────────────────────────────────
app.use("/orgs", apiKeyAuth, requireOrgId, sendRoutes);
app.use("/orgs", apiKeyAuth, requireOrgId, statusRoutes.orgs);

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
