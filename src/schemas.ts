import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security scheme ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
  description: "Service-to-service API key",
});

// ===== Shared enums =====

const TrackLinksSchema = z.enum(["None", "HtmlAndText", "HtmlOnly", "TextOnly"]);

const EmailHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

// ===== Send Email =====

export const SendEmailRequestSchema = z
  .object({
    brandIds: z.array(z.string()).optional().openapi({ description: "Brand IDs" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID" }),
    featureSlug: z.string().optional().openapi({ description: "Feature slug for tracking" }),
    workflowSlug: z.string().optional().openapi({ description: "Workflow slug for tracking/grouping" }),
    leadId: z.string().optional().openapi({ description: "Lead ID for tracking and dedup" }),
    from: z.string().optional().openapi({ description: "Sender email address. If omitted, resolved from key-service (provider: postmark-from-address)." }),
    to: z.string().openapi({ description: "Recipient email address" }),
    subject: z.string().openapi({ description: "Email subject line" }),
    htmlBody: z.string().optional().openapi({ description: "HTML email body" }),
    textBody: z.string().optional().openapi({ description: "Plain text email body" }),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    replyTo: z.string().optional(),
    tag: z.string().optional(),
    headers: z.array(EmailHeaderSchema).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    trackOpens: z.boolean().optional().default(true),
    trackLinks: TrackLinksSchema.optional(),
  })
  .refine((data) => data.htmlBody || data.textBody, {
    message: "Either htmlBody or textBody is required",
  })
  .openapi("SendEmailRequest");

export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

export const SendEmailResponseSchema = z
  .object({
    success: z.boolean(),
    messageId: z.string().optional(),
    submittedAt: z.string().optional().openapi({ format: "date-time" }),
    sendingId: z.string().optional(),
    errorCode: z.number().optional(),
    message: z.string().optional(),
  })
  .openapi("SendEmailResponse");

export type SendEmailResponse = z.infer<typeof SendEmailResponseSchema>;

// ===== Batch Send =====

export const BatchSendRequestSchema = z
  .object({
    emails: z
      .array(
        z.object({
          brandIds: z.array(z.string()).optional(),
          campaignId: z.string().optional(),
          featureSlug: z.string().optional(),
          workflowSlug: z.string().optional(),
          leadId: z.string().optional(),
          from: z.string().optional(),
          to: z.string(),
          subject: z.string(),
          htmlBody: z.string().optional(),
          textBody: z.string().optional(),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          replyTo: z.string().optional(),
          tag: z.string().optional(),
          headers: z.array(EmailHeaderSchema).optional(),
          metadata: z.record(z.string(), z.string()).optional(),
          trackOpens: z.boolean().optional().default(true),
          trackLinks: TrackLinksSchema.optional(),
        })
      )
      .min(1)
      .max(500),
  })
  .openapi("BatchSendRequest");

export type BatchSendRequest = z.infer<typeof BatchSendRequestSchema>;

const BatchResultItemSchema = z.object({
  to: z.string(),
  success: z.boolean(),
  messageId: z.string().optional(),
  sendingId: z.string().optional(),
  errorCode: z.number().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export const BatchSendResponseSchema = z
  .object({
    total: z.number(),
    successCount: z.number(),
    failCount: z.number(),
    results: z.array(BatchResultItemSchema),
  })
  .openapi("BatchSendResponse");

export type BatchSendResponse = z.infer<typeof BatchSendResponseSchema>;

// ===== Email Status (Layer 2 — no raw events exposed) =====

const MessageStatusSchema = z.object({
  contacted: z.boolean().openapi({ description: "A sending exists for this message" }),
  sent: z.boolean().openapi({ description: "Sending accepted by Postmark (errorCode=0), or implied by downstream events" }),
  delivered: z.boolean().openapi({ description: "Delivery webhook received, or implied by open/click. False if bounced" }),
  opened: z.boolean().openapi({ description: "Open webhook received, or implied by click" }),
  clicked: z.boolean().openapi({ description: "Click webhook received (never implied)" }),
  replied: z.boolean().openapi({ description: "Always false — Postmark has no reply tracking" }),
  replyClassification: z.string().nullable().openapi({ description: "Always null — Postmark has no reply tracking" }),
  bounced: z.boolean().openapi({ description: "Bounce webhook received" }),
  unsubscribed: z.boolean().openapi({ description: "SubscriptionChange with suppress_sending=true" }),
  lastDeliveredAt: z.string().nullable().openapi({ format: "date-time", description: "ISO timestamp of delivery" }),
}).openapi("MessageStatus");

export const EmailStatusSchema = z
  .object({
    messageId: z.string(),
    sending: z.object({
      id: z.string(),
      to: z.string(),
      from: z.string(),
      subject: z.string(),
      submittedAt: z.string().nullable().openapi({ format: "date-time" }),
      orgId: z.string().nullable(),
      runId: z.string().nullable(),
    }),
    status: MessageStatusSchema,
  })
  .openapi("EmailStatus");

export type EmailStatus = z.infer<typeof EmailStatusSchema>;

// ===== Org Emails Response =====

export const OrgEmailsResponseSchema = z
  .object({
    orgId: z.string(),
    count: z.number(),
    emails: z.array(
      z.object({
        messageId: z.string().nullable(),
        to: z.string(),
        subject: z.string(),
        submittedAt: z.string().nullable(),
        status: MessageStatusSchema,
      })
    ),
  })
  .openapi("OrgEmailsResponse");

// ===== Run Emails Response =====

export const RunEmailsResponseSchema = z
  .object({
    runId: z.string(),
    total: z.number(),
    emails: z.array(
      z.object({
        messageId: z.string().nullable(),
        to: z.string(),
        subject: z.string(),
        submittedAt: z.string().nullable(),
        status: MessageStatusSchema,
      })
    ),
  })
  .openapi("RunEmailsResponse");

// ===== Unified Status Lookup =====

const ScopeStatusSchema = z.object({
  contacted: z.boolean().openapi({ description: "True if at least one sending exists in this scope" }),
  sent: z.boolean().openapi({ description: "True if at least one email was accepted by Postmark (errorCode=0), or implied by downstream events" }),
  delivered: z.boolean().openapi({ description: "True if at least one email was delivered, or implied by open/click. False if bounced" }),
  opened: z.boolean().openapi({ description: "True if at least one email was opened, or implied by click" }),
  clicked: z.boolean().openapi({ description: "True if at least one link was clicked (never implied)" }),
  replied: z.boolean().openapi({ description: "True if at least one reply was received (always false for Postmark — no reply tracking)" }),
  replyClassification: z.string().nullable().openapi({ description: "Reply sentiment classification (always null for Postmark)" }),
  bounced: z.boolean().openapi({ description: "True if at least one email bounced" }),
  unsubscribed: z.boolean().openapi({ description: "True if the recipient unsubscribed via a sending in this scope" }),
  lastDeliveredAt: z.string().nullable().openapi({ format: "date-time", description: "ISO timestamp of the most recent delivery in this scope" }),
}).openapi("ScopeStatus");

const GlobalScopeSchema = z.object({
  email: z.object({
    bounced: z.boolean().openapi({ description: "True if any email to this address bounced across all campaigns in the org" }),
    unsubscribed: z.boolean().openapi({ description: "True if the recipient unsubscribed from any campaign in the org" }),
  }).openapi({ description: "Org-wide email health flags (not scoped to brand or campaign)" }),
}).openapi("GlobalScope");

export const StatusRequestSchema = z
  .object({
    brandIds: z.array(z.string()).optional().openapi({ description: "Brand UUIDs — activates brand mode: returns byCampaign breakdown + aggregated brand scope. Ignored if campaignId is also provided.", example: ["b1a2c3d4-5678-90ab-cdef-111111111111"] }),
    campaignId: z.string().optional().openapi({ description: "Campaign UUID — activates campaign mode: returns campaign-scoped status. Takes precedence over brandIds.", example: "c1a2b3d4-5678-90ab-cdef-222222222222" }),
    items: z.array(
      z.object({
        email: z.string().email().openapi({ description: "Recipient email address to look up", example: "alice@example.com" }),
      })
    ).min(1).max(1000).openapi({ description: "List of emails to check (1–1000)" }),
  })
  .openapi("StatusRequest");

export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const StatusResponseSchema = z
  .object({
    results: z.array(
      z.object({
        email: z.string().openapi({ description: "The email address that was looked up" }),
        byCampaign: z.record(z.string(), ScopeStatusSchema).nullable().openapi({ description: "Per-campaign breakdown (brand mode only). Keys are campaign UUIDs, values are scoped status. Null in campaign and global modes." }),
        brand: ScopeStatusSchema.nullable().openapi({ description: "Aggregated status across all campaigns for the brand (brand mode only). BOOL_OR across campaigns. Null in campaign and global modes." }),
        campaign: ScopeStatusSchema.nullable().openapi({ description: "Status scoped to the requested campaignId (campaign mode only). Null in brand and global modes." }),
        global: GlobalScopeSchema.openapi({ description: "Org-wide email health flags. Always present in all modes." }),
      })
    ),
  })
  .openapi("StatusResponse");

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ===== Stats =====

export const GroupByEnum = z.enum(["brandIds", "campaignId", "workflowSlug", "featureSlug", "workflowDynastySlug", "featureDynastySlug", "recipientEmail"]);

export const StatsQuerySchema = z
  .object({
    runIds: z.string().optional().openapi({ description: "Comma-separated run IDs" }),
    orgId: z.string().optional().openapi({ description: "Filter by organization ID" }),
    brandIds: z.string().optional().openapi({ description: "Filter by brand IDs (comma-separated)" }),
    campaignId: z.string().optional().openapi({ description: "Filter by campaign ID" }),
    workflowSlugs: z.string().optional().openapi({ description: "Filter by workflow slugs (comma-separated)" }),
    featureSlugs: z.string().optional().openapi({ description: "Filter by feature slugs (comma-separated)" }),
    workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug (resolves to all versioned slugs via workflow-service)" }),
    featureDynastySlug: z.string().optional().openapi({ description: "Filter by feature dynasty slug (resolves to all versioned slugs via features-service)" }),
    groupBy: GroupByEnum.optional().openapi({ description: "Group results by dimension" }),
  })
  .openapi("StatsQuery");

export type StatsQuery = z.infer<typeof StatsQuerySchema>;

const RepliesDetailSchema = z.object({
  interested: z.number(),
  meetingBooked: z.number(),
  closed: z.number(),
  notInterested: z.number(),
  wrongPerson: z.number(),
  unsubscribe: z.number(),
  neutral: z.number(),
  autoReply: z.number(),
  outOfOffice: z.number(),
});

const StatsObjectSchema = z.object({
  emailsContacted: z.number(),
  emailsSent: z.number(),
  emailsDelivered: z.number(),
  emailsOpened: z.number(),
  emailsClicked: z.number(),
  emailsBounced: z.number(),
  repliesPositive: z.number(),
  repliesNegative: z.number(),
  repliesNeutral: z.number(),
  repliesAutoReply: z.number(),
  repliesDetail: RepliesDetailSchema,
});

export const StatsResponseSchema = z
  .object({
    stats: StatsObjectSchema,
    recipients: z.number(),
  })
  .openapi("StatsResponse");

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const GroupedStatsResponseSchema = z
  .object({
    groups: z.array(
      z.object({
        key: z.string(),
        stats: StatsObjectSchema,
        recipients: z.number(),
      })
    ),
  })
  .openapi("GroupedStatsResponse");

export type GroupedStatsResponse = z.infer<typeof GroupedStatsResponseSchema>;

// ===== Performance Leaderboard =====

const WorkflowStatsSchema = z.object({
  workflowSlug: z.string(),
  emailsContacted: z.number(),
  emailsSent: z.number(),
  emailsDelivered: z.number(),
  emailsOpened: z.number(),
  emailsClicked: z.number(),
  emailsBounced: z.number(),
  openRate: z.number().openapi({ description: "Opens / sent (0-1)" }),
  clickRate: z.number().openapi({ description: "Clicks / sent (0-1)" }),
  bounceRate: z.number().openapi({ description: "Bounces / sent (0-1)" }),
  deliveryRate: z.number().openapi({ description: "Deliveries / sent (0-1)" }),
});

export const LeaderboardResponseSchema = z
  .object({
    workflows: z.array(WorkflowStatsSchema),
  })
  .openapi("LeaderboardResponse");

export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

// ===== Health =====

const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

// ===== Webhook =====

const WebhookResponseSchema = z
  .object({
    success: z.boolean(),
    recordType: z.string(),
  })
  .openapi("WebhookResponse");

const WebhookUrlResponseSchema = z
  .object({
    webhookUrl: z.string().url(),
    events: z.array(z.string()),
    instructions: z.string(),
  })
  .openapi("WebhookUrlResponse");

// ===== Error schema =====

const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.string().optional(),
    required: z.array(z.string()).optional(),
    message: z.string().optional(),
  })
  .openapi("ErrorResponse");

const InsufficientCreditsResponseSchema = z
  .object({
    error: z.literal("Insufficient credits"),
    balance_cents: z.number().nullable(),
    required_cents: z.number(),
  })
  .openapi("InsufficientCreditsResponse");

// ================================================================
// Register all API paths
// ================================================================

// --- Health ---

registry.registerPath({
  method: "get",
  path: "/",
  summary: "Service info",
  description: "Returns service name",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service info string",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  description: "Returns service health status",
  tags: ["Health"],
  responses: {
    200: {
      description: "Health status",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// --- Email Sending ---

registry.registerPath({
  method: "post",
  path: "/orgs/send",
  summary: "Send a single email",
  description:
    "Send an email via Postmark and record it in the database. Runs-service integration is BLOCKING.",
  tags: ["Email Sending"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({}),
    headers: z.object({
      "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID (injected by workflow-service)" }),
      "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s), comma-separated for multi-brand campaigns (injected by workflow-service). Example: uuid1,uuid2,uuid3" }),
      "x-feature-slug": z.string().optional().openapi({ description: "Feature slug (injected by workflow-service)" }),
      "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug (injected by workflow-service)" }),
    }),
    body: {
      content: { "application/json": { schema: SendEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Email sent successfully",
      content: { "application/json": { schema: SendEmailResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "Insufficient credits (platform key only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/send/batch",
  summary: "Send batch emails",
  description:
    "Send up to 500 emails in one request. Runs-service integration is BLOCKING for each email.",
  tags: ["Email Sending"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({}),
    headers: z.object({
      "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID (injected by workflow-service)" }),
      "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s), comma-separated for multi-brand campaigns (injected by workflow-service). Example: uuid1,uuid2,uuid3" }),
      "x-feature-slug": z.string().optional().openapi({ description: "Feature slug (injected by workflow-service)" }),
      "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug (injected by workflow-service)" }),
    }),
    body: {
      content: { "application/json": { schema: BatchSendRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Batch results",
      content: { "application/json": { schema: BatchSendResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "Insufficient credits (platform key only)",
      content: { "application/json": { schema: InsufficientCreditsResponseSchema } },
    },
  },
});

// --- Email Status ---

registry.registerPath({
  method: "get",
  path: "/internal/status/{messageId}",
  summary: "Get email status",
  description:
    "Get the full delivery status of an email by its Postmark message ID",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      messageId: z.string().openapi({ description: "Postmark message ID" }),
    }),
  },
  responses: {
    200: {
      description: "Email status",
      content: { "application/json": { schema: EmailStatusSchema } },
    },
    404: {
      description: "Message not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/status/by-org/{orgId}",
  summary: "Get emails by organization",
  description: "Get recent emails for an organization",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      orgId: z.string().openapi({ description: "Organization ID" }),
    }),
    query: z.object({
      limit: z
        .string()
        .optional()
        .openapi({ description: "Max results to return. Omit to return all." }),
    }),
  },
  responses: {
    200: {
      description: "Organization emails",
      content: { "application/json": { schema: OrgEmailsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/status/by-run/{runId}",
  summary: "Get emails by run",
  description: "Get all emails for a specific run",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      runId: z.string().openapi({ description: "Run ID" }),
    }),
  },
  responses: {
    200: {
      description: "Run emails",
      content: { "application/json": { schema: RunEmailsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/status",
  summary: "Batch status lookup by email",
  description: [
    "Check delivery status for a batch of email addresses. The response shape depends on the body filters:",
    "",
    "| brandIds | campaignId | Mode     | Active fields                  |",
    "|----------|------------|----------|--------------------------------|",
    "| absent   | absent     | Global   | global                         |",
    "| present  | absent     | Brand    | byCampaign + brand + global    |",
    "| absent   | present    | Campaign | campaign + global              |",
    "| present  | present    | Campaign | campaign + global (brandIds ignored) |",
    "",
    "Non-applicable fields are null. Headers (x-brand-id, x-campaign-id, etc.) are for tracing/logging only — they do NOT drive filtering logic. Filters are in the request body.",
    "",
    "Aggregation rules:",
    "- byCampaign[id].*: exact status for that campaign",
    "- brand.*: BOOL_OR across all campaigns of the brand (true if true in any campaign)",
    "- brand.lastDeliveredAt: MAX across all campaigns",
    "- global.email.bounced/unsubscribed: aggregated across all campaigns in the org (no brand/campaign filter)",
  ].join("\n"),
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatusRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Per-item status results. Shape depends on mode — see description.",
      content: { "application/json": { schema: StatusResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/stats",
  summary: "Get aggregated stats",
  description:
    "Get aggregated email stats optionally filtered by runIds, orgId, brandIds, campaignId, workflowSlugs, featureSlugs, workflowDynastySlug, and/or featureDynastySlug. Dynasty slug filters resolve to all versioned slugs via the respective service. When groupBy is provided, returns grouped results. Requires x-org-id header.",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    query: StatsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated stats (flat or grouped depending on groupBy parameter)",
      content: {
        "application/json": {
          schema: z.union([StatsResponseSchema, GroupedStatsResponseSchema]),
        },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/stats",
  summary: "Get aggregated stats (service auth only)",
  description:
    "Same as GET /orgs/stats but only requires X-API-Key (no identity headers). Used by email-gateway for transactional stats aggregation.",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    query: StatsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated stats (flat or grouped depending on groupBy parameter)",
      content: {
        "application/json": {
          schema: z.union([StatsResponseSchema, GroupedStatsResponseSchema]),
        },
      },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Performance ---

registry.registerPath({
  method: "get",
  path: "/public/performance/leaderboard",
  summary: "Workflow performance leaderboard",
  description:
    "Returns global workflow performance stats. API key only, no identity headers required.",
  tags: ["Performance"],
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "Workflow leaderboard",
      content: { "application/json": { schema: LeaderboardResponseSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Webhooks ---

registry.registerPath({
  method: "get",
  path: "/webhooks/postmark/url",
  summary: "Get webhook URL",
  description:
    "Returns the webhook URL that BYOK users should configure in their Postmark dashboard, along with the list of event types to enable.",
  tags: ["Webhooks"],
  responses: {
    200: {
      description: "Webhook configuration details",
      content: { "application/json": { schema: WebhookUrlResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/webhooks/postmark",
  summary: "Postmark webhook handler",
  description:
    "Receives Postmark webhook events (Delivery, Bounce, Open, Click, SpamComplaint, SubscriptionChange)",
  tags: ["Webhooks"],
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: WebhookResponseSchema } },
    },
  },
});
