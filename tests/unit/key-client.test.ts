import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAppKey } from "../../src/lib/key-client";

describe("key-client", () => {
  const originalFetch = globalThis.fetch;
  const defaultCaller = { method: "POST", path: "/send" };

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

    const result = await getAppKey("my-app", "postmark", defaultCaller);

    expect(result).toEqual({ provider: "postmark", key: "pm-token-123" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/internal/app-keys/postmark/decrypt?appId=my-app",
      {
        method: "GET",
        headers: {
          "x-api-key": "test-key-service-api-key",
          "X-Caller-Service": "postmark-service",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/send",
        },
      }
    );
  });

  it("should send caller headers from the originating endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "token" }),
    });

    await getAppKey("my-app", "postmark", { method: "POST", path: "/send/batch" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Caller-Service": "postmark-service",
          "X-Caller-Method": "POST",
          "X-Caller-Path": "/send/batch",
        }),
      })
    );
  });

  it("should throw a clear error when key is not found (404)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    await expect(getAppKey("unknown-app", "postmark", defaultCaller)).rejects.toThrow(
      'No Postmark key configured for appId "unknown-app". Register it via key-service first.'
    );
  });

  it("should throw on non-404 errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal server error"),
    });

    await expect(getAppKey("my-app", "postmark", defaultCaller)).rejects.toThrow(
      "key-service GET /internal/app-keys/postmark/decrypt failed: 500 - Internal server error"
    );
  });

  it("should URL-encode appId and provider", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "token" }),
    });

    await getAppKey("app with spaces", "post/mark", defaultCaller);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/internal/app-keys/post%2Fmark/decrypt?appId=app%20with%20spaces",
      expect.any(Object)
    );
  });
});
