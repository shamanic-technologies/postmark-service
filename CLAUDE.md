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

## Migrations & CI test DB (gotchas)

- **`drizzle-kit generate` is BROKEN in this repo** — the `drizzle/meta/*_snapshot.json` files are hand-authored stubs (fake ids like `0d13d013-…`, don't even include `postmark_messages`) left over from earlier hand-authored migrations, so generate fails with `… pointing to a parent snapshot … which is a collision`. **Hand-author new migrations**: write `drizzle/<NNNN>_<name>.sql` (idempotent — `ADD COLUMN IF NOT EXISTS`, `CREATE … IF NOT EXISTS`, `--> statement-breakpoint` between statements), append a `_journal.json` entry (`idx`, `version:"7"`, strictly-increasing `when`, `tag`), and add a `<NNNN>_snapshot.json` stub (copy the previous one, swap `id`/`prevId`). The runtime migrator only reads the `.sql` + journal `when`; the unit guard `drizzle-migrations.test.ts` only checks the journal/sql/snapshot files EXIST.
- **CI integration tests do NOT use the migration SQL** — `.github/workflows/test.yml` runs `drizzle-kit push --force` from `src/db/schema.ts` onto a `postgres:16` service container the runner throws away, then `npm run test:integration`. The container replaced a per-PR Neon branch when the Neon project was deleted; it gives the same isolation with no API key and no cleanup step. So `schema.ts` is the source of truth CI tests against; the hand-authored migration SQL only feeds the prod/staging runtime migrator (`drizzle migrate()` on boot) + the guard test. Keep `schema.ts` and the migration in sync.
- **Verify integration locally without touching prod** — spin an ephemeral local Postgres (`docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`, or `initdb` + `pg_ctl` on a temp dir), `POSTMARK_SERVICE_DATABASE_URL=postgresql://…?sslmode=disable npx drizzle-kit push --force`, run `npm run test:integration`. NEVER point integration tests at a real database — `cleanTestData()` deletes ALL rows.

## Who pays for a send — `payer`, and why a platform notification cannot be org-billed

Every send is classified as paid by the **org** or by the **platform**, by
`resolvePayer` (`src/lib/payer.ts`), and the classification decides which run the
spend is declared on:

| payer | run | cost row | consequence |
|---|---|---|---|
| `org` (default) | `POST /v1/runs`, org identity | `organization_id = <org>` | runs-service counts it in `GET /internal/org-usage-total`; billing charges the org |
| `platform` | `POST /v1/platform-runs`, **no org at all** | `organization_id = NULL` | no org-spend SUM can reach it; the platform absorbs it |

An org is billed for a cost row iff `cost_source = 'platform'` **and** the row's
`organization_id` is that org (runs-service `is_platform_projected`, migration 0017 +
the denormalized org of migration 0029). So `costSource` is not the payer — it is
which Postmark key paid the vendor, and it stays truthful. The org on the run is the
payer, and that is the single lever this service pulls.

`createPlatformRun` / `addPlatformCosts` / `updatePlatformRun` deliberately send **no
`x-org-id` / `x-user-id`**. runs-service accepts both on `/v1/platform-runs` and
stores them, which would put the cost straight back into that org's usage total —
passing them would undo the fix while looking like better attribution. The recipient
org stays on `postmark_sendings.org_id`, and `postmark_sendings.payer` (migration
0016) records which side paid, so a platform-paid send is auditable from this service
alone.

**Classification, highest precedence first:** the caller's `payer` field on the send
body → the `PLATFORM_LIFECYCLE_TAGS` backstop → `org`. The tag list cannot be the
mechanism: `tag` is the free-form eventType transactional-email-service reads out of
its own `email_templates` table, so a copy of that namespace kept here goes stale
silently on every template added there, and it goes stale in the billed direction.
Only the service that decided to send the mail knows it was platform-initiated —
that service should send `payer: "platform"`. `tests/unit/payer-routing.test.ts` pins
both paths; `tests/unit/platform-run-headers.test.ts` pins the no-org invariant.

**Why this is not merely a billing preference.** Prod 2026-08-29, org `b645207b-…`:
`credits-reload-failed` was org-billed, so sending it authorized credits, which made
billing retry the declined card, which produced another `credits-reload-failed` —
2,939 authorizations and 2,938 declined charges in 71 minutes, one every ~1.5s, until
the issuer moved the card from `insufficient_funds` to a flat `generic_decline`. A
notification about an organization's billing state must not be able to move that
state. billing-service capped its own amplification afterwards (per-org reload
backoff + one notification per failure streak, 2,939 → 7), but the cycle only stops
existing once the notification costs the org nothing.

## Credit-authorize gate — platform lifecycle tags are never gated

`/orgs/send` + `/orgs/send/batch` call billing-service `authorizeCredits` for platform-key sends (BYOK/org keys never authorize — the org pays the provider). **Exception:** platform-paid sends (`resolvePayer` → `platform`) are platform-initiated (the platform sends them; not customer-value delivery) and must NEVER be blocked on the recipient org's credit balance — a brand-new org sits at $0 (→402) and billing cold-start cascades 502. The allowlist `PLATFORM_LIFECYCLE_TAGS` (in `src/lib/lifecycle-tags.ts`) is the backstop `resolvePayer` reads; run + cost accounting still happens, on a platform run (see above). `/send/batch` authorizes only the org-paid email count and opens each email's ledger against its own payer.

Absent an explicit `payer`, the classification keys on `body.tag`, which is the `eventType` set by transactional-email-service (`tag: eventType`). **Cross-service coupling: a new lifecycle eventType in transactional-email-service must either send `payer: "platform"` or register its tag in `PLATFORM_LIFECYCLE_TAGS`, or that email will be credit-gated AND billed to the org it is about.** Current set: `welcome`, `signup_notification`, `signin_notification`, `user_active`, `waitlist`, plus the whole billing-notification family — `credits-reload-failed`, `credit-depleted`, `credit-depleted-followup-3d`, `credit-depleted-followup-10d`, and the three `-blocked` variants.

**The billing family is not there for the $0-org reason — it is there because a notification about the org's billing state must not be able to MOVE that state.** Authorizing credits for one of these mails re-enters billing-service's charge path, and these are precisely the mails sent BECAUSE that path just failed, so the notification re-triggers what it reports on. Prod 2026-08-29, org `b645207b-…`: `credits-reload-failed` was org-billed while only `credit-depleted` was exempt → send authorizes → billing retries the declined card → 402 → another `credits-reload-failed` → **2,939 authorizations and 2,938 declined charges in 71 minutes**, one every ~1.5s, until the issuer moved the card from `insufficient_funds` to a flat `generic_decline`. billing-service capped its own side afterwards (per-org reload backoff + one notification per failure streak), but the cycle only stops existing once the notification costs the org nothing. **Adding a billing/dunning eventType in billing-service means adding it here in the same breath** — `tests/unit/billing-auth-gate.test.ts` pins the family, tag by tag.

## BCC — this service never adds a recipient of its own

`sendEmail` forwards `params.bcc` verbatim (and sends no BCC when the caller supplied none). **Do NOT reintroduce a service-added BCC — not hardcoded, not behind an env var.** Postmark bills PER RECIPIENT and counts blind copies: a hardcoded staff BCC, concatenated on top of the list transactional-email-service already sent, billed that address twice on every message and drove a 4.45x multiplier (July 2026: 628 API calls → 2,797 billed emails, against a 100/month free-plan cap). The archival need is already covered — Postmark keeps the full message 45 days in Activity, and `postmark_sendings` keeps a permanent metadata row per send.

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
- `src/lib/payer.ts` — `resolvePayer` — who is charged for a send (`platform` | `org`)
- `src/lib/send-ledger.ts` — `openSendLedger` — opens the run + cost ledger against that payer
- `src/lib/runs-client.ts` — Runs service HTTP client
- `src/db/schema.ts` — Drizzle table definitions
- `src/db/index.ts` — Database connection
- `src/lib/silver.ts` — `upsertSilver(messageId)` + `recomputeLayer2()` — single chokepoint for Layer 2
- `scripts/backfill-silver.ts` — one-shot bronze → silver rebuild
- `scripts/generate-openapi.ts` — OpenAPI spec generation script
- `tests/` — Test files (unit/, integration/, fixtures/, helpers/)
- `openapi.json` — Auto-generated, do NOT edit manually

## Delivery Status Architecture (bronze / silver)

### Core principle: all endpoints read from silver — never bronze

Stats and status endpoints read from the **silver** table `postmark_messages` (Layer 2 already materialized). Bronze event tables are write-only on the read path: never JOINed at query time, never JS-aggregated. That is what keeps a stats query cheap no matter how much bronze accumulates behind it.

> **No gold/rollup layer.** A `postmark_stats_daily` gold rollup + 5-min refresh cron existed historically but was **removed** (migration `0013_drop_stats_daily`): it had zero readers across the fleet, and the 5-min cron kept the database awake around the clock (the compute was Neon then, and the cron blocked its scale-to-zero). The zero-readers half is the part that still decides: a rollup nobody reads is one to delete whatever it costs to keep warm. The cross-org feature leaderboard is served **live from silver** via `GET /internal/stats?groupBy=workflowSlug` — kept fast by the covering index `idx_messages_feature_workflow_email` (migration 0012). Live silver is always real-time; there is no rollup staleness to manage.

### Bronze — Layer 1: raw Postmark events (write-only)

Append-only storage of every webhook received from Postmark. One row per event, never updated, never deleted. Each event type has its own table with type-specific columns. **Read endpoints never touch these tables.**

| Table | Webhook event | Unique per message? | Key extra columns |
|-------|--------------|--------------------|--------------------|
| `postmark_sendings` | *(not a webhook — created at send time)* | yes (`message_id`) | `error_code`, `to_email`, `org_id`, `payer`, `campaign_id`, `brand_ids`, `lead_id` |
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
| `lastDeliveredAt` | string? | ISO 8601 timestamp of most recent delivery (MAX) |
| `firstContactedAt` | string? | First-occurrence (MIN) ISO timestamp of contacted = `submitted_at ?? created_at` |
| `firstSentAt` | string? | MIN timestamp of sent (same source, gated on `sent`) |
| `firstDeliveredAt` | string? | MIN timestamp of delivered = `last_delivered_at ?? first_opened_at`, gated on `delivered` |
| `firstOpenedAt` | string? | MIN(`postmark_openings.received_at`), implied by click when no open webhook |
| `firstClickedAt` | string? | MIN(`postmark_link_clicks.received_at`) (never implied) |
| `firstRepliedAt` | string? | Always `null` — Postmark has no reply tracking |
| `firstBouncedAt` | string? | `postmark_bounces.bounced_at` |
| `firstUnsubscribedAt` | string? | `postmark_subscription_changes.changed_at` |

The 8 `first*At` are **first-occurrence (MIN)** timestamps mirroring `lastDeliveredAt` (MAX), surfaced for funnel chronology / cumulative revenue time-series (DIS-229). Each is non-null **iff** its boolean is true (implication baked in `recomputeLayer2`). Only `first_opened_at` / `first_clicked_at` / `first_bounced_at` / `first_unsubscribed_at` are stored on silver (migration `0014`); `firstContactedAt` / `firstSentAt` / `firstDeliveredAt` are derived at read from existing columns. In brand mode, brand-scope `first*At` = MIN across the brand's campaigns (consistent with BOOL_OR booleans / MAX `lastDeliveredAt`). **Populated on `POST /orgs/status` only** — the `/internal/status/*` endpoints use the local `MessageStatus` shape and are unchanged.

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

### No gold/rollup layer (removed)

There is no Layer 3. The `postmark_stats_daily` gold rollup + its 5-min refresh cron were removed in migration `0013_drop_stats_daily` — zero readers across the fleet, and the cron was the sole repeating SQL keeping the database busy around the clock (Neon then, where it blocked scale-to-zero at the 0.25 CU floor). The cross-org feature leaderboard is served **live from silver** via `GET /internal/stats?groupBy=workflowSlug&featureSlugs=…` (called by email-gateway), kept fast by the covering index `idx_messages_feature_workflow_email` (migration 0012). No rebuild job, no rollup staleness.

### Write path summary

```
POST /send              → INSERT bronze.postmark_sendings → upsertSilver(messageId)
POST /webhooks/postmark → INSERT bronze.postmark_<event>  → upsertSilver(messageId)
```

No timer/cron touches the DB: when the service is idle (no sends, no webhooks) nothing queries Postgres. That mattered acutely on Neon, where an idle compute suspended after 300s and a single repeating query would have held it awake. Postgres is now a container on the box and never suspends, so nothing is saved by it any more — but a timer that queries for no reader is still a timer that queries for no reader, so do not add one.

**Cold-start connect handling.** The first DB call after a suspend hits a compute that is still resuming (~1–7s). Node 20's happy-eyeballs would abort each address at 250ms, so the connect fails with `AggregateError [ETIMEDOUT]` before the wake completes. `src/db/index.ts` neutralizes this: it raises `autoSelectFamilyAttemptTimeout` to 5s and wraps `pool.query` with `withConnectRetry` (`src/db/retry.ts`) — connection-acquisition errors (ETIMEDOUT/ECONNREFUSED/"timeout expired") retry with backoff (250/500/1000ms). Retry is connect-phase only (pre-dispatch), so it is write-safe; SQL errors and statement timeouts are never retried. It was written for Neon's suspend/resume cycle, which no longer exists — the database is a local container now. The wrapper is kept because a connect-phase retry is right whenever a pool can transiently fail to hand out a connection, not only on a waking compute; what is gone is the daily cold start that made it urgent.

### Read path summary

```
GET  /internal/status/:messageId    → SELECT FROM postmark_messages WHERE message_id
GET  /internal/status/by-org/:orgId → SELECT FROM postmark_messages WHERE org_id
GET  /internal/status/by-run/:runId → SELECT FROM postmark_messages WHERE run_id
POST /orgs/status                   → SELECT FROM postmark_messages WHERE to_email IN (...) AND org_id
GET  /orgs/stats, /internal/stats   → SELECT COUNT(*) FILTER (...) FROM postmark_messages WHERE <filters>
GET  /public/performance/leaderboard→ SELECT FROM postmark_messages GROUP BY workflow_slug  (silver, global)
```

The cross-org feature leaderboard (mounted upstream in features-service, fanned out by email-gateway) reads silver live via `GET /internal/stats?groupBy=workflowSlug&featureSlugs=…` — the covering index `idx_messages_feature_workflow_email` makes this an index-only GroupAggregate, no rollup table needed.

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
| `GET /orgs/stats` | Aggregated counts by unique recipient | org-scoped, filterable — **≥1 filter required** (empty filter → 400; the handler scopes via `?orgId`, NOT the `x-org-id` header, so an unfiltered call must not leak cross-org) |
| `GET /internal/stats` | Same as /orgs/stats, service auth only | used by email-gateway. **Empty filter allowed → global cross-org aggregate** (same scope class as the public leaderboard); pass any filter to scope |
| `GET /internal/status/{messageId}` | Single email: sending metadata + Layer 2 status | single message |
| `GET /internal/status/by-org/{orgId}` | List of emails with Layer 2 status each | org-wide |
| `GET /internal/status/by-run/{runId}` | List of emails with Layer 2 status each | single run |
| `GET /public/performance/leaderboard` | Per-workflow aggregated counts + rates | global |

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. Same convention as email-gateway-service and (pending) instantly-service.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` (on `StatusScope`) and `notSending` (on `RecipientStats`). They live on instantly responses today; postmark pads them with neutral defaults (`cancelled: false` in `aggregateScope()`, `notSending: 0` in `buildRecipientStatsObject()`) so consumers see a consistent shape across providers. Contract v2 will tighten them to required after instantly confirms its responses still match.

Dep pinned at **`^1.1.0`**, which widened `StatusScope` with 8 optional+nullable `first*At` first-occurrence (MIN) timestamps (`firstContactedAt` … `firstUnsubscribedAt`). postmark populates the 7 it tracks on `POST /orgs/status`; `firstRepliedAt` is always `null` (no reply tracking). See the `ScopedStatusFields` table above for per-field derivation.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph (especially under Vitest's module-graph evaluation order, which is not guaranteed), so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.

Chained methods on contract schemas (`.nullable()`, `.optional()`) return fresh ZodNullable / ZodOptional instances and would normally have `.openapi`, but Vitest's evaluation order is unreliable — prefer `.describe(...)` (core Zod, always available) over `.openapi({ description })` when chaining off a contract schema.
