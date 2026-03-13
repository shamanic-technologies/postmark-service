/**
 * HTTP client for key-service
 * Fetches decrypted org/platform keys for dynamic Postmark token resolution
 */

function getKeyServiceUrl(): string {
  return process.env.KEY_SERVICE_URL || "http://localhost:3001";
}

function getKeyServiceApiKey(): string {
  return process.env.KEY_SERVICE_API_KEY || "";
}

export interface DecryptedKey {
  provider: string;
  key: string;
  keySource: "platform" | "org";
}

export interface CallerContext {
  method: string;
  path: string;
}

export type PostmarkStreamType = "broadcast" | "inbound" | "transactional";

/**
 * Resolve a Postmark stream ID from key-service.
 * Providers: postmark-broadcast-stream, postmark-inbound-stream, postmark-transactional-stream
 */
export async function getStreamId(
  orgId: string,
  userId: string,
  streamType: PostmarkStreamType,
  caller: CallerContext,
  trackingHeaders: Record<string, string> = {}
): Promise<string> {
  const provider = `postmark-${streamType}-stream`;
  const result = await getOrgKey(orgId, userId, provider, caller, trackingHeaders);
  return result.key;
}

/**
 * Resolve the default "from" address from key-service.
 * Provider: postmark-from-address
 * Platform registers a default; orgs can override via BYOK.
 */
export async function getFromAddress(
  orgId: string,
  userId: string,
  caller: CallerContext,
  trackingHeaders: Record<string, string> = {}
): Promise<string> {
  const result = await getOrgKey(orgId, userId, "postmark-from-address", caller, trackingHeaders);
  return result.key;
}

/**
 * Fetch a decrypted key from key-service using org-based resolution
 * @param orgId - The organization ID
 * @param userId - The user ID (required for logging even if not used for resolution)
 * @param provider - The provider name (e.g. "postmark")
 * @param caller - The caller context (HTTP method + path of the originating endpoint)
 * @returns The decrypted key with keySource
 * @throws Error if key-service is unreachable or key not found
 */
export async function getOrgKey(
  orgId: string,
  userId: string,
  provider: string,
  caller: CallerContext,
  trackingHeaders: Record<string, string> = {}
): Promise<DecryptedKey> {
  const url = `${getKeyServiceUrl()}/keys/${encodeURIComponent(provider)}/decrypt`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": getKeyServiceApiKey(),
      "x-org-id": orgId,
      "x-user-id": userId,
      "X-Caller-Service": "postmark-service",
      "X-Caller-Method": caller.method,
      "X-Caller-Path": caller.path,
      ...trackingHeaders,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 404) {
      throw new Error(
        `No Postmark key configured for orgId "${orgId}". Register it via key-service first.`
      );
    }
    throw new Error(
      `key-service GET /keys/${provider}/decrypt failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<DecryptedKey>;
}
