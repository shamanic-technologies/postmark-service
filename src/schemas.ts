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
    brandId: z.string().optional().openapi({ description: "Brand ID" }),
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
          brandId: z.string().optional(),
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

// ===== Email Status =====

export const EmailStatusSchema = z
  .object({
    messageId: z.string(),
    status: z.enum(["sent", "delivered", "bounced", "opened", "clicked"]),
    sending: z.object({
      id: z.string(),
      to: z.string(),
      from: z.string(),
      subject: z.string(),
      submittedAt: z.string().nullable().openapi({ format: "date-time" }),
      orgId: z.string().nullable(),
      runId: z.string().nullable(),
    }),
    delivery: z
      .object({
        deliveredAt: z.string().nullable().openapi({ format: "date-time" }),
        recipient: z.string().nullable(),
      })
      .nullable(),
    bounce: z
      .object({
        type: z.string().nullable(),
        typeCode: z.number().nullable(),
        description: z.string().nullable(),
        bouncedAt: z.string().nullable().openapi({ format: "date-time" }),
        email: z.string().nullable(),
      })
      .nullable(),
    openings: z.array(z.object({
      receivedAt: z.string().nullable(),
      firstOpen: z.boolean().nullable(),
      platform: z.string().nullable(),
      readSeconds: z.number().nullable(),
      geo: z.any().nullable(),
    })),
    clicks: z.array(z.object({
      receivedAt: z.string().nullable(),
      originalLink: z.string().nullable(),
      clickLocation: z.string().nullable(),
      platform: z.string().nullable(),
      geo: z.any().nullable(),
    })),
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
        id: z.string(),
        messageId: z.string().nullable(),
        to: z.string(),
        subject: z.string(),
        submittedAt: z.string().nullable(),
        runId: z.string().nullable(),
        errorCode: z.number().nullable(),
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
        id: z.string(),
        messageId: z.string().nullable(),
        to: z.string(),
        subject: z.string(),
        submittedAt: z.string().nullable(),
        success: z.boolean(),
      })
    ),
  })
  .openapi("RunEmailsResponse");

// ===== Unified Status Lookup =====

const LeadStatusSchema = z.object({
  contacted: z.boolean(),
  delivered: z.boolean(),
  replied: z.boolean(),
  lastDeliveredAt: z.string().nullable().openapi({ format: "date-time" }),
});

const EmailStatusDetailSchema = z.object({
  contacted: z.boolean(),
  delivered: z.boolean(),
  bounced: z.boolean(),
  unsubscribed: z.boolean(),
  lastDeliveredAt: z.string().nullable().openapi({ format: "date-time" }),
});

const ScopeStatusSchema = z.object({
  lead: LeadStatusSchema,
  email: EmailStatusDetailSchema,
});

const GlobalStatusSchema = z.object({
  email: z.object({
    bounced: z.boolean(),
    unsubscribed: z.boolean(),
  }),
});

export const StatusRequestSchema = z
  .object({
    brandId: z.string().openapi({ description: "Brand ID — primary dedup scope" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID — optional scope" }),
    items: z.array(
      z.object({
        leadId: z.string().openapi({ description: "Lead ID" }),
        email: z.string().email().openapi({ description: "Email address" }),
      })
    ).min(1).max(1000).openapi({ description: "Lead+email pairs to check" }),
  })
  .openapi("StatusRequest");

export type StatusRequest = z.infer<typeof StatusRequestSchema>;

export const StatusResponseSchema = z
  .object({
    results: z.array(
      z.object({
        leadId: z.string(),
        email: z.string(),
        campaign: ScopeStatusSchema.nullable(),
        brand: ScopeStatusSchema,
        global: GlobalStatusSchema,
      })
    ),
  })
  .openapi("StatusResponse");

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ===== Stats =====

export const GroupByEnum = z.enum(["brandId", "campaignId", "workflowSlug", "featureSlug", "workflowDynastySlug", "featureDynastySlug", "leadEmail"]);

export const StatsQuerySchema = z
  .object({
    runIds: z.string().optional().openapi({ description: "Comma-separated run IDs" }),
    orgId: z.string().optional().openapi({ description: "Filter by organization ID" }),
    brandId: z.string().optional().openapi({ description: "Filter by brand ID" }),
    campaignId: z.string().optional().openapi({ description: "Filter by campaign ID" }),
    workflowSlug: z.string().optional().openapi({ description: "Filter by workflow slug" }),
    featureSlug: z.string().optional().openapi({ description: "Filter by feature slug" }),
    workflowDynastySlug: z.string().optional().openapi({ description: "Filter by workflow dynasty slug (resolves to all versioned slugs via workflow-service)" }),
    featureDynastySlug: z.string().optional().openapi({ description: "Filter by feature dynasty slug (resolves to all versioned slugs via features-service)" }),
    groupBy: GroupByEnum.optional().openapi({ description: "Group results by dimension" }),
  })
  .openapi("StatsQuery");

export type StatsQuery = z.infer<typeof StatsQuerySchema>;

const StatsObjectSchema = z.object({
  emailsContacted: z.number(),
  emailsSent: z.number(),
  emailsDelivered: z.number(),
  emailsOpened: z.number(),
  emailsClicked: z.number(),
  emailsReplied: z.number(),
  emailsBounced: z.number(),
  repliesWillingToMeet: z.number(),
  repliesInterested: z.number(),
  repliesNotInterested: z.number(),
  repliesOutOfOffice: z.number(),
  repliesUnsubscribe: z.number(),
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
  path: "/send",
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
  path: "/send/batch",
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
  path: "/status/{messageId}",
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
  path: "/status/by-org/{orgId}",
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
        .openapi({ description: "Max results (default: 50)" }),
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
  path: "/status/by-run/{runId}",
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
  path: "/status",
  summary: "Batch status lookup by lead and email",
  description:
    "Check delivery status for lead+email pairs. Returns campaign-scoped (optional), brand-scoped, and global results.",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatusRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Per-item status results",
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
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Get aggregated email stats optionally filtered by runIds, orgId, brandId, campaignId, workflowSlug, featureSlug, workflowDynastySlug, and/or featureDynastySlug. Dynasty slug filters resolve to all versioned slugs via the respective service. When no filters are provided, returns stats across all sendings. When groupBy is provided, returns grouped results. Requires x-org-id and x-user-id headers.",
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
  path: "/stats/public",
  summary: "Get aggregated stats (service auth only)",
  description:
    "Same as GET /stats but only requires X-API-Key (no x-org-id, x-user-id, x-run-id headers). Used by email-gateway for transactional stats aggregation.",
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
  path: "/performance/leaderboard",
  summary: "Workflow performance leaderboard",
  description:
    "Returns global workflow performance stats. Requires x-org-id and x-user-id headers.",
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
