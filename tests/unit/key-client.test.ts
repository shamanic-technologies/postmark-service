import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAppKey } from "../../src/lib/key-client";

describe("key-client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://key-service:3001";
    process.env.KEY_SERVICE_API_KEY = "test-key-service-api-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.KEY_SERVICE_URL;
    delete process.env.KEY_SERVICE_API_KEY;
  });

  it("should fetch a decrypted app key from key-service", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "pm-token-123" }),
    });

    const result = await getAppKey("my-app", "postmark");

    expect(result).toEqual({ provider: "postmark", key: "pm-token-123" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/internal/app-keys/postmark/decrypt?appId=my-app",
      {
        method: "GET",
        headers: { "x-api-key": "test-key-service-api-key" },
      }
    );
  });

  it("should throw a clear error when key is not found (404)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    await expect(getAppKey("unknown-app", "postmark")).rejects.toThrow(
      'No Postmark key configured for appId "unknown-app". Register it via key-service first.'
    );
  });

  it("should throw on non-404 errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal server error"),
    });

    await expect(getAppKey("my-app", "postmark")).rejects.toThrow(
      "key-service GET /internal/app-keys/postmark/decrypt failed: 500 - Internal server error"
    );
  });

  it("should URL-encode appId and provider", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "token" }),
    });

    await getAppKey("app with spaces", "post/mark");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/internal/app-keys/post%2Fmark/decrypt?appId=app%20with%20spaces",
      expect.any(Object)
    );
  });
});
