/**
 * HTTP client for key-service
 * Fetches decrypted app keys for dynamic Postmark token resolution
 */

function getKeyServiceUrl(): string {
  return process.env.KEY_SERVICE_URL || "http://localhost:3001";
}

function getKeyServiceApiKey(): string {
  return process.env.KEY_SERVICE_API_KEY || "";
}

export interface DecryptedAppKey {
  provider: string;
  key: string;
}

export interface CallerContext {
  method: string;
  path: string;
}

/**
 * Fetch a decrypted app key from key-service
 * @param appId - The app identifier (e.g. "my-saas-app")
 * @param provider - The provider name (e.g. "postmark")
 * @param caller - The caller context (HTTP method + path of the originating endpoint)
 * @returns The decrypted key
 * @throws Error if key-service is unreachable or key not found
 */
export type PostmarkStreamType = "broadcast" | "inbound" | "transactional";

/**
 * Resolve a Postmark stream ID from key-service.
 * Providers: postmark-broadcast-stream, postmark-inbound-stream, postmark-transactional-stream
 */
export async function getStreamId(
  appId: string,
  streamType: PostmarkStreamType,
  caller: CallerContext
): Promise<string> {
  const provider = `postmark-${streamType}-stream`;
  const result = await getAppKey(appId, provider, caller);
  return result.key;
}

export async function getAppKey(
  appId: string,
  provider: string,
  caller: CallerContext
): Promise<DecryptedAppKey> {
  const url = `${getKeyServiceUrl()}/internal/app-keys/${encodeURIComponent(provider)}/decrypt?appId=${encodeURIComponent(appId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": getKeyServiceApiKey(),
      "X-Caller-Service": "postmark-service",
      "X-Caller-Method": caller.method,
      "X-Caller-Path": caller.path,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 404) {
      throw new Error(
        `No Postmark key configured for appId "${appId}". Register it via key-service first.`
      );
    }
    throw new Error(
      `key-service GET /internal/app-keys/${provider}/decrypt failed: ${response.status} - ${errorText}`
    );
  }

  return response.json() as Promise<DecryptedAppKey>;
}
