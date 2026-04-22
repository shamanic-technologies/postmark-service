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

## brandId convention

`brandId` is **always a string** — single UUID or comma-separated CSV (`"uuid1,uuid2,uuid3"`). This applies everywhere: request body, query params, and headers. **Never use `z.array(z.string())`** for brandId in Zod schemas.

The receiving handler is responsible for splitting the CSV internally:
```ts
const brandIds = brandIdRaw.split(",").map(s => s.trim()).filter(Boolean);
```

The DB column (`postmark_sendings.brand_ids`) is `text[]` — the split happens at the handler boundary, not in the schema.

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

## Delivery Status Architecture

### Core principle: all endpoints expose Layer 2

Every endpoint that returns status or stats exposes **Layer 2** — consolidated status computed from raw events using the implication chain. No endpoint ever exposes Layer 1 raw events (no `delivery: {}`, `bounce: {}`, `openings[]`, `clicks[]`). Layer 2 is computed the same way everywhere — no special cases, no inconsistencies between endpoints.

### Layer 1 — Raw Postmark events (internal storage only)

Append-only storage of every webhook received from Postmark. One row per event, never updated, never deleted. Each event type has its own table with type-specific columns. **Never exposed to consumers.**

| Table | Webhook event | Unique per message? | Key extra columns |
|-------|--------------|--------------------|--------------------|
| `postmark_sendings` | *(not a webhook — created at send time)* | yes (`message_id`) | `error_code`, `to_email`, `org_id`, `campaign_id`, `brand_ids`, `lead_id` |
| `postmark_deliveries` | Delivery | yes | `delivered_at`, `recipient` |
| `postmark_bounces` | Bounce | yes | `type`, `type_code`, `description`, `bounced_at` |
| `postmark_openings` | Open | **no** (multi-open) | `first_open`, `platform`, `read_seconds`, `geo` |
| `postmark_link_clicks` | Click | **no** (multi-click) | `original_link`, `click_location`, `platform`, `geo` |
| `postmark_spam_complaints` | SpamComplaint | yes | `email`, `from_address` |
| `postmark_subscription_changes` | SubscriptionChange | yes | `suppress_sending`, `origin`, `changed_at` |

Webhook handlers (`src/routes/webhooks.ts`) are pure "dump into DB" — no business logic, no status derivation.

### Layer 2 — Consolidated status (the only thing consumers see)

Computed at query time from Layer 1 events. The implication chain ensures that downstream events automatically set upstream statuses (e.g. a click implies opened, delivered, sent, contacted). This handles missing or delayed webhooks.

**Implication chain:** `contacted → sent → delivered → opened → clicked`

| Event Layer 1 | contacted | sent | delivered | opened | clicked | bounced | unsubscribed |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `postmark_sendings` exists | **true** | | | | | | |
| `postmark_sendings` errorCode=0 | true | **true** | | | | | |
| `postmark_deliveries` | true | true | **true** | | | | |
| `postmark_openings` | true | true | true | **true** | | | |
| `postmark_link_clicks` | true | true | true | true | **true** | | |
| `postmark_bounces` | true | true | **false** | | | **true** | |
| `postmark_subscription_changes` (suppress=true) | true | true | | | | | **true** |

Key rules:
- `bounced`: implies `sent = true` (the email was attempted) but forces `delivered = false` (it did not reach the recipient)
- `clicked` is NEVER implied — only an explicit Click webhook sets it
- `replied` / `replyClassification` are always false/null — Postmark has no reply tracking. These fields exist for shape alignment with instantly-service

### Layer 2 status fields (`ScopedStatusFields`)

Used by all endpoints. Shape is aligned with instantly-service.

| Field | Type | Description |
|-------|------|-------------|
| `contacted` | boolean | A sending exists for this recipient in scope |
| `sent` | boolean | Sending with errorCode === 0, OR implied by any downstream event |
| `delivered` | boolean | Delivery webhook exists, OR implied by opened/clicked. **false** if bounced |
| `opened` | boolean | Open webhook exists, OR implied by clicked |
| `clicked` | boolean | Click webhook exists (never implied) |
| `replied` | boolean | Always `false` — Postmark has no reply tracking |
| `replyClassification` | string? | Always `null` — Postmark has no reply tracking |
| `bounced` | boolean | Bounce webhook exists |
| `unsubscribed` | boolean | SubscriptionChange with suppress_sending = true |
| `lastDeliveredAt` | string? | ISO 8601 timestamp of most recent delivery |

### Counting convention (stats endpoints)

All stats endpoints count by **unique recipient** (unique `to_email`), not by messageId or event count. A recipient is counted once per metric regardless of how many messages were sent to them.

The implication chain applies to counting too — if a recipient has a click but no open webhook, they count in `emailsOpened`. This ensures stats are consistent with boolean status fields.

| Metric | Definition |
|--------|------------|
| `emailsContacted` | Unique recipients with any sending in scope |
| `emailsSent` | Unique recipients with errorCode=0 OR any downstream event |
| `emailsDelivered` | Unique recipients with delivery webhook OR implied by open/click. Excludes bounced recipients |
| `emailsOpened` | Unique recipients with open webhook OR implied by click |
| `emailsClicked` | Unique recipients with click webhook (never implied) |
| `emailsBounced` | Unique recipients with bounce webhook |
| `recipients` | Same as `emailsSent` |

Note: unlike instantly-service which computes `delivered = sent - bounced` (because they lack a delivery signal), postmark-service uses the **real Postmark delivery webhook** plus implications. This is more accurate.

### Status endpoint modes (`POST /orgs/status`)

| Mode | Input | Fields populated |
|------|-------|-----------------|
| Campaign mode | `{ campaignId, items }` | `campaign` + `global` |
| Brand mode | `{ brandId, items }` (no campaignId) | `byCampaign` (per-campaign breakdown) + `brand` (aggregated) + `global` |
| Global only | `{ items }` | `global` only |

Brand aggregation rules:
- Boolean fields (`contacted`, `sent`, `delivered`, `opened`, `clicked`, `replied`, `bounced`, `unsubscribed`): BOOL_OR across campaigns
- `replyClassification`: always null (no reply tracking)
- `lastDeliveredAt`: MAX across campaigns

### Endpoint inventory

Every endpoint below returns Layer 2 only. No exceptions.

| Endpoint | What it returns | Scope |
|----------|----------------|-------|
| `POST /orgs/status` | Per-email boolean status (ScopedStatusFields) | campaign/brand/global modes |
| `GET /orgs/stats` | Aggregated counts by unique recipient | org-scoped, filterable |
| `GET /internal/stats` | Same as /orgs/stats, service auth only | used by email-gateway |
| `GET /internal/status/{messageId}` | Single email: sending metadata + Layer 2 status | single message |
| `GET /internal/status/by-org/{orgId}` | List of emails with Layer 2 status each | org-wide |
| `GET /internal/status/by-run/{runId}` | List of emails with Layer 2 status each | single run |
| `GET /public/performance/leaderboard` | Per-workflow aggregated counts + rates | global |
