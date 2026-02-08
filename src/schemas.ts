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
    orgId: z.string().optional().openapi({ description: "Clerk organization ID (optional for admin/lifecycle emails)" }),
    runId: z.string().openapi({ description: "Parent run ID" }),
    brandId: z.string().optional().openapi({ description: "Brand ID" }),
    appId: z.string().optional().openapi({ description: "App ID" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID" }),
    from: z.string().openapi({ description: "Sender email address" }),
    to: z.string().openapi({ description: "Recipient email address" }),
    subject: z.string().openapi({ description: "Email subject line" }),
    htmlBody: z.string().optional().openapi({ description: "HTML email body" }),
    textBody: z.string().optional().openapi({ description: "Plain text email body" }),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    replyTo: z.string().optional(),
    tag: z.string().optional(),
    messageStream: z
      .string()
      .optional()
      .default("broadcast")
      .openapi({ description: "Postmark message stream" }),
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
          orgId: z.string().optional(),
          runId: z.string(),
          brandId: z.string().optional(),
          appId: z.string().optional(),
          campaignId: z.string().optional(),
          from: z.string(),
          to: z.string(),
          subject: z.string(),
          htmlBody: z.string().optional(),
          textBody: z.string().optional(),
          cc: z.string().optional(),
          bcc: z.string().optional(),
          replyTo: z.string().optional(),
          tag: z.string().optional(),
          messageStream: z.string().optional().default("broadcast"),
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

// ===== Stats =====

export const StatsRequestSchema = z
  .object({
    runIds: z.array(z.string()).optional().openapi({ description: "Filter by run IDs" }),
    clerkOrgId: z.string().optional().openapi({ description: "Filter by Clerk organization ID" }),
    brandId: z.string().optional().openapi({ description: "Filter by brand ID" }),
    appId: z.string().optional().openapi({ description: "Filter by app ID" }),
    campaignId: z.string().optional().openapi({ description: "Filter by campaign ID" }),
  })
  .openapi("StatsRequest");

export type StatsRequest = z.infer<typeof StatsRequestSchema>;

export const StatsResponseSchema = z
  .object({
    stats: z.object({
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
    }),
  })
  .openapi("StatsResponse");

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

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

// ===== Error schema =====

const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.string().optional(),
    required: z.array(z.string()).optional(),
    message: z.string().optional(),
  })
  .openapi("ErrorResponse");

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
  path: "/stats",
  summary: "Get aggregated stats",
  description:
    "Get aggregated email stats filtered by runIds, clerkOrgId, brandId, appId, and/or campaignId. At least one filter required.",
  tags: ["Email Status"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Webhooks ---

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
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
