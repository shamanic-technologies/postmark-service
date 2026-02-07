import swaggerAutogen from "swagger-autogen";
import path from "path";
import fs from "fs";

const doc = {
  info: {
    title: "Postmark Service API",
    description:
      "Email sending and tracking service built on Postmark. Handles email delivery via the broadcast message stream, webhook processing for delivery events, and integrates with a runs-service for cost tracking.",
    version: "1.0.0",
  },
  servers: [
    { url: "http://localhost:3010", description: "Local development" },
  ],
  tags: [
    { name: "Health", description: "Health check endpoints" },
    { name: "Email Sending", description: "Send emails via Postmark" },
    { name: "Email Status", description: "Query email delivery status" },
    { name: "Webhooks", description: "Postmark webhook handlers" },
  ],
  securityDefinitions: {
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
      description: "Service-to-service API key",
    },
  },
};

const outputFile = path.resolve(__dirname, "../openapi.json");
const routes = [
  path.resolve(__dirname, "../src/routes/health.ts"),
  path.resolve(__dirname, "../src/routes/send.ts"),
  path.resolve(__dirname, "../src/routes/status.ts"),
  path.resolve(__dirname, "../src/routes/webhooks.ts"),
];

// Manually-defined schemas (swagger-autogen wraps these incorrectly)
const schemas = {
  SendEmailRequest: {
    type: "object",
    required: ["orgId", "runId", "brandId", "appId", "campaignId", "from", "to", "subject"],
    properties: {
      orgId: { type: "string", description: "Clerk organization ID" },
      runId: { type: "string", description: "Parent run ID" },
      brandId: { type: "string", description: "Brand ID" },
      appId: { type: "string", description: "App ID" },
      campaignId: { type: "string", description: "Campaign ID" },
      from: { type: "string", description: "Sender email address" },
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      htmlBody: { type: "string", description: "HTML email body" },
      textBody: { type: "string", description: "Plain text email body" },
      cc: { type: "string" },
      bcc: { type: "string" },
      replyTo: { type: "string" },
      tag: { type: "string" },
      messageStream: {
        type: "string",
        default: "broadcast",
        description: "Postmark message stream",
      },
      headers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
        },
      },
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      trackOpens: { type: "boolean", default: true },
      trackLinks: {
        type: "string",
        enum: ["None", "HtmlAndText", "HtmlOnly", "TextOnly"],
      },
    },
  },
  SendEmailResponse: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      messageId: { type: "string" },
      submittedAt: { type: "string", format: "date-time" },
      sendingId: { type: "string" },
    },
  },
  BatchSendRequest: {
    type: "object",
    required: ["emails"],
    properties: {
      emails: {
        type: "array",
        items: { $ref: "#/components/schemas/SendEmailRequest" },
        maxItems: 500,
      },
    },
  },
  BatchSendResponse: {
    type: "object",
    properties: {
      total: { type: "integer" },
      successCount: { type: "integer" },
      failCount: { type: "integer" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            to: { type: "string" },
            success: { type: "boolean" },
            messageId: { type: "string" },
            sendingId: { type: "string" },
            errorCode: { type: "integer" },
            message: { type: "string" },
            error: { type: "string" },
          },
        },
      },
    },
  },
  EmailStatus: {
    type: "object",
    properties: {
      messageId: { type: "string" },
      status: {
        type: "string",
        enum: ["sent", "delivered", "bounced", "opened", "clicked"],
      },
      sending: {
        type: "object",
        properties: {
          id: { type: "string" },
          to: { type: "string" },
          from: { type: "string" },
          subject: { type: "string" },
          submittedAt: { type: "string", format: "date-time" },
          orgId: { type: "string" },
          runId: { type: "string" },
        },
      },
      delivery: {
        type: "object",
        nullable: true,
        properties: {
          deliveredAt: { type: "string", format: "date-time" },
          recipient: { type: "string" },
        },
      },
      bounce: {
        type: "object",
        nullable: true,
        properties: {
          type: { type: "string" },
          typeCode: { type: "integer" },
          description: { type: "string" },
          bouncedAt: { type: "string", format: "date-time" },
          email: { type: "string" },
        },
      },
      openings: { type: "array", items: { type: "object" } },
      clicks: { type: "array", items: { type: "object" } },
    },
  },
  StatsRequest: {
    type: "object",
    properties: {
      runIds: { type: "array", items: { type: "string" }, description: "Filter by run IDs" },
      clerkOrgId: { type: "string", description: "Filter by Clerk organization ID" },
      brandId: { type: "string", description: "Filter by brand ID" },
      appId: { type: "string", description: "Filter by app ID" },
      campaignId: { type: "string", description: "Filter by campaign ID" },
    },
  },
  StatsResponse: {
    type: "object",
    properties: {
      stats: {
        type: "object",
        properties: {
          emailsSent: { type: "integer" },
          emailsDelivered: { type: "integer" },
          emailsOpened: { type: "integer" },
          emailsClicked: { type: "integer" },
          emailsReplied: { type: "integer" },
          emailsBounced: { type: "integer" },
          repliesWillingToMeet: { type: "integer" },
          repliesInterested: { type: "integer" },
          repliesNotInterested: { type: "integer" },
          repliesOutOfOffice: { type: "integer" },
          repliesUnsubscribe: { type: "integer" },
        },
      },
    },
  },
};

swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc).then(
  (result) => {
    if (!result?.success) {
      console.error("Failed to generate OpenAPI spec");
      process.exit(1);
    }

    // Post-process: replace auto-generated schemas with our clean definitions
    const spec = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
    spec.components = {
      schemas,
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "Service-to-service API key",
        },
      },
    };
    fs.writeFileSync(outputFile, JSON.stringify(spec, null, 2));

    console.log("OpenAPI spec generated at openapi.json");
  }
);
