import { 
  pgTable, 
  uuid, 
  text, 
  timestamp, 
  integer, 
  boolean,
  jsonb,
  bigint,
  numeric,
  uniqueIndex,
  index
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
    orgId: text("org_id"), // Clerk org ID or internal org ID
    runId: text("run_id"), // Parent run ID from caller
    brandId: text("brand_id"),
    appId: text("app_id"),
    campaignId: text("campaign_id"),
    workflowName: text("workflow_name"),
    metadata: jsonb("metadata"), // Additional context
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_sendings_message_id").on(table.messageId),
    index("idx_sendings_org").on(table.orgId),
    index("idx_sendings_run").on(table.runId),
    index("idx_sendings_brand").on(table.brandId),
    index("idx_sendings_app").on(table.appId),
    index("idx_sendings_campaign").on(table.campaignId),
    index("idx_sendings_workflow").on(table.workflowName),
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


// Local users table (maps to Clerk)
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_clerk_id").on(table.clerkUserId),
  ]
);

// Local orgs table (maps to Clerk)
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_clerk_id").on(table.clerkOrgId),
  ]
);

// Task type registry
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
);

// Task runs (individual executions)
export const tasksRuns = pgTable(
  "tasks_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .references(() => users.id),
    status: text("status").notNull().default("running"), // running, completed, failed
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tasks_runs_task").on(table.taskId),
    index("idx_tasks_runs_org").on(table.orgId),
    index("idx_tasks_runs_status").on(table.status),
  ]
);

// Cost line items per task run
export const tasksRunsCosts = pgTable(
  "tasks_runs_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskRunId: uuid("task_run_id")
      .notNull()
      .references(() => tasksRuns.id, { onDelete: "cascade" }),
    costName: text("cost_name").notNull(),
    units: integer("units").notNull(),
    costPerUnitInUsdCents: numeric("cost_per_unit_in_usd_cents", { precision: 12, scale: 10 }).notNull(),
    totalCostInUsdCents: numeric("total_cost_in_usd_cents", { precision: 12, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_tasks_runs_costs_run").on(table.taskRunId),
    index("idx_tasks_runs_costs_name").on(table.costName),
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
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskRun = typeof tasksRuns.$inferSelect;
export type NewTaskRun = typeof tasksRuns.$inferInsert;
export type TaskRunCost = typeof tasksRunsCosts.$inferSelect;
export type NewTaskRunCost = typeof tasksRunsCosts.$inferInsert;
