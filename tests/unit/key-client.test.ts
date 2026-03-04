import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOrgKey, getStreamId } from "../../src/lib/key-client";

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

  it("should fetch a decrypted org key from key-service", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "pm-token-123", keySource: "platform" }),
    });

    const result = await getOrgKey("org-1", "user-1", "postmark", defaultCaller);

    expect(result).toEqual({ provider: "postmark", key: "pm-token-123", keySource: "platform" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/keys/postmark/decrypt",
      {
        method: "GET",
        headers: {
          "x-api-key": "test-key-service-api-key",
          "x-org-id": "org-1",
          "x-user-id": "user-1",
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
      json: () => Promise.resolve({ provider: "postmark", key: "token", keySource: "org" }),
    });

    await getOrgKey("org-1", "user-1", "postmark", { method: "POST", path: "/send/batch" });

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

    await expect(getOrgKey("unknown-org", "user-1", "postmark", defaultCaller)).rejects.toThrow(
      'No Postmark key configured for orgId "unknown-org". Register it via key-service first.'
    );
  });

  it("should throw on non-404 errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal server error"),
    });

    await expect(getOrgKey("org-1", "user-1", "postmark", defaultCaller)).rejects.toThrow(
      "key-service GET /keys/postmark/decrypt failed: 500 - Internal server error"
    );
  });

  it("should URL-encode provider and send identity as headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "token", keySource: "platform" }),
    });

    await getOrgKey("org with spaces", "user/slash", "post/mark", defaultCaller);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/keys/post%2Fmark/decrypt",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-org-id": "org with spaces",
          "x-user-id": "user/slash",
        }),
      })
    );
  });

  it("should return keySource from key-service response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark", key: "token", keySource: "org" }),
    });

    const result = await getOrgKey("org-1", "user-1", "postmark", defaultCaller);
    expect(result.keySource).toBe("org");
  });
});

describe("getStreamId", () => {
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

  it("should resolve broadcast stream ID from key-service", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark-broadcast-stream", key: "broadcast", keySource: "platform" }),
    });

    const streamId = await getStreamId("org-1", "user-1", "broadcast", defaultCaller);

    expect(streamId).toBe("broadcast");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/keys/postmark-broadcast-stream/decrypt",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
        }),
      })
    );
  });

  it("should resolve transactional stream ID from key-service", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark-transactional-stream", key: "outbound", keySource: "platform" }),
    });

    const streamId = await getStreamId("org-1", "user-1", "transactional", defaultCaller);

    expect(streamId).toBe("outbound");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/keys/postmark-transactional-stream/decrypt",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
        }),
      })
    );
  });

  it("should resolve inbound stream ID from key-service", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "postmark-inbound-stream", key: "inbound", keySource: "platform" }),
    });

    const streamId = await getStreamId("org-1", "user-1", "inbound", defaultCaller);

    expect(streamId).toBe("inbound");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://key-service:3001/keys/postmark-inbound-stream/decrypt",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-org-id": "org-1",
          "x-user-id": "user-1",
        }),
      })
    );
  });

  it("should propagate key-service errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Not found"),
    });

    await expect(getStreamId("unknown-org", "user-1", "broadcast", defaultCaller)).rejects.toThrow(
      'No Postmark key configured for orgId "unknown-org"'
    );
  });
});
