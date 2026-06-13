import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "dist", "tests", "*.config.ts"],
    },
    // Run all tests sequentially for integration tests that share DB
    fileParallelism: false,
    maxWorkers: 1,
    // CI runs integration tests against a freshly-created Neon branch whose
    // compute is cold; the first heavy-insert test (leaderboard.test.ts does
    // ~4 serial upsertSilver round-trips) can exceed the vitest 5s default
    // while the compute resumes. Raise the per-test ceiling so a cold-start
    // resume is a slow pass, not a flaky timeout. Unit tests stay far under it.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
