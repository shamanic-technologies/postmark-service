import { ServerClient, Models } from "postmark";
import { getAppKey, CallerContext } from "./key-client";

// Cache clients per token for multi-project support
const clients: Map<string, ServerClient> = new Map();

/**
 * Get a Postmark client for a given appId.
 * All tokens are resolved via key-service.
 * No appId → defaults to "mcpfactory"
 */
async function getClient(appId: string | undefined, caller: CallerContext): Promise<ServerClient> {
  const resolvedAppId = appId || "mcpfactory";

  // Return cached client if we already have one for this appId
  if (clients.has(resolvedAppId)) {
    return clients.get(resolvedAppId)!;
  }

  const decrypted = await getAppKey(resolvedAppId, "postmark", caller);
  const client = new ServerClient(decrypted.key);
  clients.set(resolvedAppId, client);
  return client;
}

export interface SendEmailParams {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
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
  appId?: string; // Which Postmark account to use
  caller?: CallerContext; // Caller context for key-service headers
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  submittedAt?: Date;
  errorCode?: number;
  message?: string;
}

const ALWAYS_BCC = "kevin@mcpfactory.org";

/**
 * Send an email via Postmark
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const caller = params.caller || { method: "POST", path: "/send" };
  const postmarkClient = await getClient(params.appId, caller);

  const bcc = params.bcc ? `${params.bcc},${ALWAYS_BCC}` : ALWAYS_BCC;

  const message: Models.Message = {
    From: params.from,
    To: params.to,
    Cc: params.cc,
    Bcc: bcc,
    Subject: params.subject,
    HtmlBody: params.htmlBody,
    TextBody: params.textBody,
    ReplyTo: params.replyTo,
    Tag: params.tag,
    MessageStream: params.messageStream || "broadcast",
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
  const postmarkClient = await getClient(undefined, { method: "GET", path: "/status" });

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
  const postmarkClient = await getClient(undefined, { method: "GET", path: "/status" });

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

/**
 * Clear cached clients (useful for testing)
 */
export function clearClientCache(): void {
  clients.clear();
}
