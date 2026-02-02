# Postmark Service - Agent Instructions

## README Update Rule (MANDATORY)

**After every code change, you MUST update `README.md` to reflect those changes.** This applies to:

- New or modified API endpoints (routes)
- New or modified database tables/columns (schema changes)
- New or changed environment variables
- New or changed npm scripts
- New dependencies that affect the tech stack
- Changes to project structure (new files/directories under `src/`)
- Changes to authentication or middleware behavior
- Changes to deployment configuration

### How to update the README

1. Read the current `README.md`
2. Read `.context/readme-rules.md` for the expected structure
3. Update only the sections affected by your changes
4. Keep it concise - the README is a reference, not documentation

If you add a new route, add it to the **API Endpoints** section.
If you add a new table, add it to the **Database Schema** section.
If you add a new env var, add it to the **Environment Variables** section.
If you add/change an npm script, update the **Scripts** table.
If you add files under `src/`, update the **Project Structure** tree.

## Project Conventions

- TypeScript strict mode
- Functional patterns over classes
- Express for HTTP, Drizzle ORM for database
- Vitest for testing (unit + integration)
- Service-to-service auth via `X-API-Key` header
- Postmark for email delivery
- Database migrations via `drizzle-kit generate`

## Testing

- `npm run test:unit` - unit tests (no DB needed)
- `npm run test:integration` - integration tests (needs DB)
- Tests run single-threaded (shared DB state)
- NODE_ENV=test skips auto-migration on startup
