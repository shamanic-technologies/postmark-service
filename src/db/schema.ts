import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Postmark email sendings - records of emails we sent
 */
export const postmarkSendings = pgTable(
  "postmark_sendings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").unique(), // Postmark MessageID
    toEmail: text("to_email").notNull(),
    fromEmail: text("from_email").notNull(),
    subject: text("subject"),
    tag: text("tag"),
    messageStream: text("message_stream"),
    // Sending result
    errorCode: integer("error_code"),
    message: text("message"), // Postmark response message
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    // Context for tracking
    orgId: text("org_id"), // Organization ID
    userId: text("user_id"), // User ID (for runs-service attribution)
    runId: text("run_id"), // Child run ID created in runs-service
    brandIds: text("brand_ids").array(),
    campaignId: text("campaign_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    leadId: text("lead_id"),
    metadata: jsonb("metadata"), // Additional context
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_sendings_message_id").on(table.messageId),
    index("idx_sendings_org").on(table.orgId),
    index("idx_sendings_run").on(table.runId),
    index("idx_sendings_brand_ids").using("gin", table.brandIds),
    index("idx_sendings_campaign").on(table.campaignId),
    index("idx_sendings_workflow").on(table.workflowSlug),
    index("idx_sendings_lead").on(table.leadId),
    index("idx_sendings_campaign_email").on(table.campaignId, table.toEmail),
    index("idx_sendings_feature_created").on(table.featureSlug, table.createdAt.desc()),
  ]
);

/**
 * Silver — Materialized Layer 2 status per message.
 * One row per messageId. UPSERTed by upsertSilver(messageId) on webhook ingest.
 * Reads (stats/status endpoints) hit this table directly — never the bronze event tables.
 */
export const postmarkMessages = pgTable(
  "postmark_messages",
  {
    messageId: uuid("message_id").primaryKey(),
    toEmail: text("to_email").notNull(),
    fromEmail: text("from_email"),
    subject: text("subject"),
    orgId: text("org_id"),
    userId: text("user_id"),
    runId: text("run_id"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    leadId: text("lead_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    errorCode: integer("error_code"),
    // Layer 2 booleans
    contacted: boolean("contacted").notNull().default(false),
    sent: boolean("sent").notNull().default(false),
    delivered: boolean("delivered").notNull().default(false),
    opened: boolean("opened").notNull().default(false),
    clicked: boolean("clicked").notNull().default(false),
    bounced: boolean("bounced").notNull().default(false),
    unsubscribed: boolean("unsubscribed").notNull().default(false),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    // Per-event first-occurrence (MIN) timestamps. Mirror of lastDeliveredAt (MAX).
    // Only the genuinely-non-derivable events get a column; firstContacted/Sent/Delivered
    // are derived at read from submitted_at / created_at / last_delivered_at.
    // firstOpenedAt carries the click-implication baked in (open ?? click), see recomputeLayer2.
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
    firstBouncedAt: timestamp("first_bounced_at", { withTimezone: true }),
    firstUnsubscribedAt: timestamp("first_unsubscribed_at", { withTimezone: true }),
    sourceAttribution: jsonb("source_attribution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastRebuiltAt: timestamp("last_rebuilt_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_messages_org").on(table.orgId),
    index("idx_messages_org_campaign").on(table.orgId, table.campaignId),
    index("idx_messages_run").on(table.runId),
    index("idx_messages_campaign").on(table.campaignId),
    index("idx_messages_brand_ids").using("gin", table.brandIds),
    index("idx_messages_workflow").on(table.workflowSlug),
    index("idx_messages_feature_created").on(table.featureSlug, table.createdAt.desc()),
    index("idx_messages_to_email").on(table.toEmail),
    index("idx_messages_lead").on(table.leadId),
    // Covering index for the cross-org leaderboard shape:
    // WHERE feature_slug IN (...) GROUP BY workflow_slug + 7x COUNT(DISTINCT to_email) FILTER (...)
    // Without this, the query falls back to a heap scan + hash agg and times out on prod-scale silver.
    index("idx_messages_feature_workflow_email").on(
      table.featureSlug,
      table.workflowSlug,
      table.toEmail
    ),
  ]
);

/**
 * Postmark deliveries - successful email deliveries
 */
export const postmarkDeliveries = pgTable(
  "postmark_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").unique(),
    recordType: text("record_type"),
    serverId: integer("server_id"),
    messageStream: text("message_stream"),
    recipient: text("recipient"),
    tag: text("tag"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    details: text("details"),
    metadata: jsonb("metadata"),
    headers: jsonb("headers"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_deliveries_message_id").on(table.messageId),
  ]
);

/**
 * Postmark bounces - bounced emails
 */
export const postmarkBounces = pgTable(
  "postmark_bounces",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // Postmark bounce ID
    recordType: text("record_type"),
    type: text("type"), // HardBounce, SoftBounce, etc.
    typeCode: integer("type_code"),
    name: text("name"),
    tag: text("tag"),
    messageId: uuid("message_id"),
    serverId: integer("server_id"),
    description: text("description"),
    details: text("details"),
    email: text("email"),
    fromAddress: text("from_address"),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    dumpAvailable: boolean("dump_available"),
    inactive: boolean("inactive"),
    canActivate: boolean("can_activate"),
    subject: text("subject"),
    content: text("content"),
    messageStream: text("message_stream"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_bounces_message_id").on(table.messageId),
  ]
);

/**
 * Postmark openings - email opens
 */
export const postmarkOpenings = pgTable(
  "postmark_openings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordType: text("record_type"),
    messageStream: text("message_stream"),
    metadata: jsonb("metadata"),
    firstOpen: boolean("first_open"),
    recipient: text("recipient"),
    messageId: uuid("message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    platform: text("platform"),
    readSeconds: integer("read_seconds"),
    tag: text("tag"),
    userAgent: text("user_agent"),
    os: jsonb("os"),
    client: jsonb("client"),
    geo: jsonb("geo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_openings_message_id").on(table.messageId), // Not unique - same email can be opened multiple times
  ]
);

/**
 * Postmark link clicks - clicked links in emails
 */
export const postmarkLinkClicks = pgTable(
  "postmark_link_clicks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordType: text("record_type"),
    messageStream: text("message_stream"),
    metadata: jsonb("metadata"),
    recipient: text("recipient"),
    messageId: uuid("message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    platform: text("platform"),
    clickLocation: text("click_location"),
    originalLink: text("original_link"),
    tag: text("tag"),
    userAgent: text("user_agent"),
    os: jsonb("os"),
    client: jsonb("client"),
    geo: jsonb("geo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_link_clicks_message_id").on(table.messageId), // Not unique - same email can have multiple clicks
  ]
);

/**
 * Postmark spam complaints
 */
export const postmarkSpamComplaints = pgTable(
  "postmark_spam_complaints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordType: text("record_type"),
    messageStream: text("message_stream"),
    metadata: jsonb("metadata"),
    messageId: uuid("message_id"),
    serverId: integer("server_id"),
    tag: text("tag"),
    email: text("email"),
    fromAddress: text("from_address"),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    subject: text("subject"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_spam_complaints_message_id").on(table.messageId),
  ]
);

/**
 * Postmark subscription changes - unsubscribes/resubscribes
 */
export const postmarkSubscriptionChanges = pgTable(
  "postmark_subscription_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordType: text("record_type"),
    messageStream: text("message_stream"),
    metadata: jsonb("metadata"),
    messageId: uuid("message_id"),
    serverId: integer("server_id"),
    tag: text("tag"),
    recipient: text("recipient"),
    origin: text("origin"), // Recipient, Customer
    suppressSending: boolean("suppress_sending"),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_subscription_changes_message_id").on(table.messageId),
  ]
);

// Type exports
export type PostmarkSending = typeof postmarkSendings.$inferSelect;
export type NewPostmarkSending = typeof postmarkSendings.$inferInsert;
export type PostmarkDelivery = typeof postmarkDeliveries.$inferSelect;
export type NewPostmarkDelivery = typeof postmarkDeliveries.$inferInsert;
export type PostmarkBounce = typeof postmarkBounces.$inferSelect;
export type NewPostmarkBounce = typeof postmarkBounces.$inferInsert;
export type PostmarkOpening = typeof postmarkOpenings.$inferSelect;
export type NewPostmarkOpening = typeof postmarkOpenings.$inferInsert;
export type PostmarkLinkClick = typeof postmarkLinkClicks.$inferSelect;
export type NewPostmarkLinkClick = typeof postmarkLinkClicks.$inferInsert;
export type PostmarkSpamComplaint = typeof postmarkSpamComplaints.$inferSelect;
export type NewPostmarkSpamComplaint = typeof postmarkSpamComplaints.$inferInsert;
export type PostmarkSubscriptionChange = typeof postmarkSubscriptionChanges.$inferSelect;
export type NewPostmarkSubscriptionChange = typeof postmarkSubscriptionChanges.$inferInsert;
export type PostmarkMessage = typeof postmarkMessages.$inferSelect;
export type NewPostmarkMessage = typeof postmarkMessages.$inferInsert;
