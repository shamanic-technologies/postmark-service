import * as dotenv from "dotenv";
import { beforeAll, afterAll } from "vitest";

// Load test environment variables
dotenv.config({ path: ".env.test" });

// Fallback to regular .env if .env.test doesn't exist
if (!process.env.POSTMARK_SERVICE_DATABASE_URL) {
  dotenv.config();
}

// Set test-specific defaults
process.env.POSTMARK_SERVICE_API_KEY = process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key";
process.env.POSTMARK_MCPFACTORY_SERVER_TOKEN = process.env.POSTMARK_MCPFACTORY_SERVER_TOKEN || "test-token";

beforeAll(() => {
  console.log("Test suite starting...");
});

afterAll(() => {
  console.log("Test suite complete.");
});
