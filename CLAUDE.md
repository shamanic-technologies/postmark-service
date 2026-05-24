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
- `src/zod-setup.ts` — Side-effect module that extends Zod with `.openapi()`. Import it BEFORE any module that creates `z.object(...).openapi("Name")` schemas.
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
- `src/lib/silver.ts` — `upsertSilver(messageId)` + `recomputeLayer2()` — single chokepoint for Layer 2
- `src/lib/gold.ts` — `refreshStatsDaily({windowDays})` — rebuild gold rollup
- `src/jobs/stats-daily-cron.ts` — 5-minute gold refresh, started post-`listen()`
- `scripts/backfill-silver.ts` — one-shot bronze → silver + gold rebuild
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (unit/, integration/, fixtures/, helpers/)
- `openapi.json` — Auto-generated, do NOT edit manually

## Delivery Status Architecture (bronze / silver / gold)

### Core principle: all endpoints read from silver / gold — never bronze

Stats and status endpoints read from the **silver** table `postmark_messages` (Layer 2 already materialized) or the **gold** rollup `postmark_stats_daily`. Bronze event tables are write-only on the read path: never JOINed at query time, never JS-aggregated. This is what keeps queries cheap regardless of geography between Railway and Neon.

### Bronze — Layer 1: raw Postmark events (write-only)

Append-only storage of every webhook received from Postmark. One row per event, never updated, never deleted. Each event type has its own table with type-specific columns. **Read endpoints never touch these tables.**

| Table | Webhook event | Unique per message? | Key extra columns |
|-------|--------------|--------------------|--------------------|
| `postmark_sendings` | *(not a webhook — created at send time)* | yes (`message_id`) | `error_code`, `to_email`, `org_id`, `campaign_id`, `brand_ids`, `lead_id` |
| `postmark_deliveries` | Delivery | yes | `delivered_at`, `recipient` |
| `postmark_bounces` | Bounce | yes | `type`, `type_code`, `description`, `bounced_at` |
| `postmark_openings` | Open | **no** (multi-open) | `first_open`, `platform`, `read_seconds`, `geo` |
| `postmark_link_clicks` | Click | **no** (multi-click) | `original_link`, `click_location`, `platform`, `geo` |
| `postmark_spam_complaints` | SpamComplaint | yes | `email`, `from_address` |
| `postmark_subscription_changes` | SubscriptionChange | yes | `suppress_sending`, `origin`, `changed_at` |

Webhook handlers (`src/routes/webhooks.ts`) are pure "dump into bronze, then `upsertSilver(messageId)`" — no business logic, no status derivation. `upsertSilver` is the single chokepoint where Layer 2 is recomputed from bronze and written to silver.

### Silver — Layer 2: materialized status (`postmark_messages`)

One row per `message_id`. Columns are typed booleans for the Layer 2 implication chain plus denormalized scope fields (`org_id`, `campaign_id`, `brand_ids[]`, `feature_slug`, `workflow_slug`, `run_id`, `lead_id`). Every read endpoint queries this table directly.

- Maintained by `src/lib/silver.ts::upsertSilver(messageId)`, invoked after each bronze write (send handler + every webhook handler).
- Backfillable from bronze via `scripts/backfill-silver.ts` — idempotent, paginated, safe to re-run.
- Indexes cover the common filter shapes: `(org_id, campaign_id)`, `(run_id)`, `(workflow_slug)`, `(feature_slug, created_at DESC)`, GIN on `brand_ids`, `(to_email)`.

The implication chain that used to be computed at query time is now computed once in `recomputeLayer2()` (`src/lib/silver.ts`) and stored. Stats endpoints become single SQL `COUNT(*) FILTER (...)` aggregates over silver — no JOINs to event tables, no JS-side bool-OR loops.

**Implication chain:** `contacted → sent → delivered → opened → clicked`

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

### Gold — Layer 3: rollup (`postmark_stats_daily`)

Pre-aggregated counts keyed by `(feature_slug, group_dim, group_key, day)` where `group_dim ∈ { "total" | "workflow_slug" | "brand_id" }`. Used by the public cross-org feature leaderboard, which scans no other table at read time.

- Rebuilt every 5 minutes by `src/jobs/stats-daily-cron.ts` (running `refreshStatsDaily({ windowDays: 7 })`).
- Cron is started **after** `app.listen()` — never on the boot path. Refresh is single-transaction, full-window DELETE+INSERT — idempotent.
- Reading the leaderboard is one SQL SELECT against gold; no fan-out, no JOINs.

### Write path summary

```
POST /send              → INSERT bronze.postmark_sendings → upsertSilver(messageId)
POST /webhooks/postmark → INSERT bronze.postmark_<event>  → upsertSilver(messageId)
cron (every 5 min)      → refreshStatsDaily({ windowDays: 7 }) → wipe + rebuild gold window
```

### Read path summary

```
GET  /internal/status/:messageId    → SELECT FROM postmark_messages WHERE message_id
GET  /internal/status/by-org/:orgId → SELECT FROM postmark_messages WHERE org_id
GET  /internal/status/by-run/:runId → SELECT FROM postmark_messages WHERE run_id
POST /orgs/status                   → SELECT FROM postmark_messages WHERE to_email IN (...) AND org_id
GET  /orgs/stats, /internal/stats   → SELECT COUNT(*) FILTER (...) FROM postmark_messages WHERE <filters>
GET  /public/performance/leaderboard→ SELECT FROM postmark_messages GROUP BY workflow_slug  (silver, global)
```

Public feature leaderboard endpoints (currently mounted upstream in features-service) hit gold via `postmark_stats_daily` when the cross-org feature dimension is requested.

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

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. Same convention as email-gateway-service and (pending) instantly-service.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` (on `StatusScope`) and `notSending` (on `RecipientStats`). They live on instantly responses today; postmark pads them with neutral defaults (`cancelled: false` in `aggregateScope()`, `notSending: 0` in `buildRecipientStatsObject()`) so consumers see a consistent shape across providers. Contract v2 will tighten them to required after instantly confirms its responses still match.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph (especially under Vitest's module-graph evaluation order, which is not guaranteed), so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.

Chained methods on contract schemas (`.nullable()`, `.optional()`) return fresh ZodNullable / ZodOptional instances and would normally have `.openapi`, but Vitest's evaluation order is unreliable — prefer `.describe(...)` (core Zod, always available) over `.openapi({ description })` when chaining off a contract schema.
