/**
 * HTTP client for email-gateway.
 *
 * postmark-service is a stateless pass-through for inbound webhooks:
 * Postmark → /webhooks/postmark → email-gateway /inbound/postmark.
 *
 * Failure semantics: on non-2xx response or network error, throw a
 * GatewayForwardError. The route maps this to 502 so Postmark's own
 * 45-min retry kicks in. No outbox, no retry queue.
 */

export class GatewayForwardError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = "GatewayForwardError";
  }
}

export function validateEmailGatewayConfig(): void {
  const missing: string[] = [];
  if (!process.env.EMAIL_GATEWAY_SERVICE_URL) missing.push("EMAIL_GATEWAY_SERVICE_URL");
  if (!process.env.EMAIL_GATEWAY_SERVICE_API_KEY) {
    missing.push("EMAIL_GATEWAY_SERVICE_API_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `[postmark-service] Missing required env vars: ${missing.join(", ")}`
    );
  }
}

export async function forwardInboundToGateway(payload: unknown): Promise<void> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new GatewayForwardError(
      "EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured"
    );
  }

  const url = `${baseUrl}/inbound/postmark`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    throw new GatewayForwardError(
      `Network error forwarding Inbound to email-gateway: ${err?.message ?? err}`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GatewayForwardError(
      `email-gateway returned ${response.status} for Inbound forward: ${text}`
    );
  }
}
