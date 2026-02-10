# Project: postmark-service

Email sending and tracking service using Postmark. Handles delivery via broadcast stream, webhook processing, and runs-service cost tracking.

## Commands

- `npm run dev` — local dev server (nodemon)
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run generate:openapi` — regenerate openapi.json only
- `npm start` — run compiled app
- `npm test` — run all tests
- `npm run test:unit` — unit tests only (no DB needed)
- `npm run test:integration` — integration tests (needs DB)
- `npm run test:coverage` — tests with coverage
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate` — run migrations
- `npm run db:push` — push schema to database

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/index.ts` — Express app setup, CORS, middleware
- `src/routes/send.ts` — Email sending (single + batch)
- `src/routes/status.ts` — Email status queries + aggregated stats
- `src/routes/webhooks.ts` — Postmark webhook handlers
- `src/routes/health.ts` — Health check routes
- `src/middleware/serviceAuth.ts` — API key auth middleware
- `src/lib/postmark-client.ts` — Postmark SDK wrapper (multi-project)
- `src/lib/runs-client.ts` — Runs service HTTP client
- `src/db/schema.ts` — Drizzle table definitions
- `src/db/index.ts` — Database connection
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (unit/, integration/, fixtures/, helpers/)
- `openapi.json` — Auto-generated, do NOT edit manually
