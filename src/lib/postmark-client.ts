import { ServerClient, Models } from "postmark";

let client: ServerClient | null = null;

function getClient(): ServerClient {
  if (!client) {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) {
      throw new Error("POSTMARK_SERVER_TOKEN is not configured");
    }
    client = new ServerClient(token);
  }
  return client;
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
  const postmarkClient = getClient();

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
