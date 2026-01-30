import { ServerClient, Models } from "postmark";

// Cache clients per token for multi-project support
const clients: Map<string, ServerClient> = new Map();

/**
 * Get a Postmark client for a specific project
 * Defaults to POSTMARK_MCPFACTORY_SERVER_TOKEN if no project specified
 */
function getClient(project?: "mcpfactory" | "pressbeat"): ServerClient {
  // Determine which token to use
  let token: string | undefined;
  let cacheKey: string;

  if (project === "pressbeat") {
    token = process.env.POSTMARK_PRESSBEAT_SERVER_TOKEN;
    cacheKey = "pressbeat";
  } else {
    // Default to mcpfactory or generic token
    token = process.env.POSTMARK_MCPFACTORY_SERVER_TOKEN || process.env.POSTMARK_SERVER_TOKEN;
    cacheKey = "mcpfactory";
  }

  if (!token) {
    throw new Error(`Postmark server token not configured for project: ${project || "default"}`);
  }

  // Return cached client or create new one
  if (!clients.has(cacheKey)) {
    clients.set(cacheKey, new ServerClient(token));
  }
  
  return clients.get(cacheKey)!;
}

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  messageStream?: string;
  headers?: { name: string; value: string }[];
  metadata?: Record<string, string>;
  trackOpens?: boolean;
  trackLinks?: "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly";
  project?: "mcpfactory" | "pressbeat"; // Which Postmark account to use
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  submittedAt?: Date;
  errorCode?: number;
  message?: string;
}

/**
 * Send an email via Postmark
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const postmarkClient = getClient(params.project);

  const message: Models.Message = {
    From: params.from,
    To: params.to,
    Subject: params.subject,
    HtmlBody: params.htmlBody,
    TextBody: params.textBody,
    ReplyTo: params.replyTo,
    Tag: params.tag,
    MessageStream: params.messageStream || "outbound",
    Headers: params.headers?.map(h => ({ Name: h.name, Value: h.value })),
    Metadata: params.metadata,
    TrackOpens: params.trackOpens ?? true,
    TrackLinks: params.trackLinks as Models.LinkTrackingOptions ?? Models.LinkTrackingOptions.HtmlAndText,
  };

  try {
    const response = await postmarkClient.sendEmail(message);
    
    return {
      success: response.ErrorCode === 0,
      messageId: response.MessageID,
      submittedAt: response.SubmittedAt ? new Date(response.SubmittedAt) : undefined,
      errorCode: response.ErrorCode,
      message: response.Message,
    };
  } catch (error: any) {
    console.error("Postmark send error:", error);
    return {
      success: false,
      errorCode: error.code || -1,
      message: error.message || "Unknown error",
    };
  }
}

/**
 * Get message details from Postmark
 */
export async function getMessageDetails(messageId: string) {
  const postmarkClient = getClient();
  
  try {
    const details = await postmarkClient.getOutboundMessageDetails(messageId);
    return details;
  } catch (error: any) {
    console.error("Postmark getMessageDetails error:", error);
    throw error;
  }
}

/**
 * Get bounce info for a message
 */
export async function getBouncesForMessage(messageId: string) {
  const postmarkClient = getClient();
  
  try {
    // Get bounces filtered by tag or search - Postmark doesn't have direct messageId filter
    // We'll need to query our database instead for specific message bounces
    const bounces = await postmarkClient.getBounces({ count: 10 });
    return bounces.Bounces.filter(b => b.MessageID === messageId);
  } catch (error: any) {
    console.error("Postmark getBounces error:", error);
    throw error;
  }
}
