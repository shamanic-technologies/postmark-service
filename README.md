# Postmark Service

Email sending and tracking service built on [Postmark](https://postmarkapp.com/). Handles email delivery via the **broadcast** message stream (for cold sales/marketing emails), webhook processing for delivery events, and integrates with a runs-service for cost tracking. Emails default to the `broadcast` stream unless overridden per request.

## API Endpoints

### Email Sending
- **POST /send** - Send a single email (from, to, subject, htmlBody/textBody, optional cc/bcc/tag/replyTo). All emails are automatically BCC'd to kevin@mcpfactory.org.
- **POST /send/batch** - Send up to 500 emails in one request. All emails are automatically BCC'd to kevin@mcpfactory.org.

### Email Status
- **GET /status/:messageId** - Full delivery status for one email (sent/delivered/bounced/opened/clicked)
- **GET /status/by-org/:orgId** - Recent emails for an organization
- **GET /status/by-run/:runId** - Emails for a specific run
- **POST /stats** - Aggregated stats across multiple runs

### Webhooks
- **POST /webhooks/postmark** - Receives Postmark webhook events (delivery, bounce, open, click, spam complaint, subscription change)

### OpenAPI
- **GET /openapi.json** - Returns the OpenAPI 3.0 specification (no auth required)

### Health
- **GET /** - Service info
- **GET /health** - Health check

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **Framework:** Express
- **Database:** PostgreSQL (Neon) via Drizzle ORM
- **Email provider:** Postmark SDK
- **API docs:** swagger-autogen (OpenAPI 3.0)
- **Testing:** Vitest + Supertest
- **Deployment:** Docker on Railway

## Database Schema

| Table | Purpose |
|-------|---------|
| `postmark_sendings` | Records of sent emails |
| `postmark_deliveries` | Successful delivery events |
| `postmark_bounces` | Bounce events (hard/soft) |
| `postmark_openings` | Email open tracking |
| `postmark_link_clicks` | Link click tracking |
| `postmark_spam_complaints` | Spam complaint events |
| `postmark_subscription_changes` | Unsubscribe/resubscribe events |
| `users` | Local user mapping (Clerk) |
| `orgs` | Local org mapping (Clerk) |
| `tasks` | Task type registry |
| `tasks_runs` | Task execution records |
| `tasks_runs_costs` | Cost line items per run |

## Setup

```bash
npm install
cp .env.example .env  # fill in values
npm run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (nodemon) |
| `npm run build` | Compile TypeScript + generate OpenAPI spec |
| `npm run generate:openapi` | Generate OpenAPI spec only |
| `npm start` | Run compiled app |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:coverage` | Tests with coverage |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |
| `npm run db:push` | Push schema to database |
| `npm run db:studio` | Open Drizzle Studio |

## Environment Variables

See [`.env.example`](.env.example) for required configuration:
- `POSTMARK_SERVICE_DATABASE_URL` - PostgreSQL connection string
- `POSTMARK_MCPFACTORY_SERVER_TOKEN` / `POSTMARK_PRESSBEAT_SERVER_TOKEN` - Postmark API tokens
- `POSTMARK_SERVICE_API_KEY` - Service-to-service auth secret
- `RUNS_SERVICE_URL` / `RUNS_SERVICE_API_KEY` - Runs service integration
- `PORT` - Server port (default: 3010)

## Authentication

All endpoints require `X-API-Key` header except:
- `GET /` and `GET /health` (public)
- `GET /openapi.json` (public)
- `POST /webhooks/postmark` (uses its own webhook secret verification)

## Project Structure

```
src/
  index.ts              # Express app setup, CORS, middleware
  db/
    index.ts            # Database connection (pg + Drizzle)
    schema.ts           # All table definitions
  lib/
    postmark-client.ts  # Postmark SDK wrapper (multi-project)
    runs-client.ts      # Runs service HTTP client
  middleware/
    serviceAuth.ts      # API key auth middleware
  routes/
    health.ts           # Health check routes
    send.ts             # Email sending (single + batch)
    status.ts           # Email status queries + stats
    webhooks.ts         # Postmark webhook handlers
scripts/
  generate-openapi.ts   # OpenAPI spec generation script
tests/
  unit/                 # Unit tests
  integration/          # Integration tests
  fixtures/             # Test payloads
  helpers/              # Test utilities (mock postmark, test db)
drizzle/                # SQL migrations + snapshots
```
