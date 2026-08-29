import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPlatformRun,
  addPlatformCosts,
  updatePlatformRun,
} from "../../src/lib/runs-client";

/**
 * runs-service stores `x-org-id` on a platform run when it is sent, and the cost
 * rows hung off that run then carry the org — which is exactly what
 * `GET /internal/org-usage-total` sums to charge the org. Sending the org here
 * would look like richer attribution and would silently restore the billing this
 * whole path exists to remove. These calls must carry the service name and no
 * organisation.
 */
describe("platform run calls carry no organisation", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "platform-run-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(call: number): Record<string, string> {
    return fetchMock.mock.calls[call][1].headers as Record<string, string>;
  }

  it("creates the run with x-service-name and no org/user identity", async () => {
    await createPlatformRun(
      { serviceName: "postmark-service", taskName: "email-send" },
      { "x-feature-slug": "welcome-email" }
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/platform-runs");
    expect(init.method).toBe("POST");
    const headers = headersOf(0);
    expect(headers["x-service-name"]).toBe("postmark-service");
    expect(headers["x-feature-slug"]).toBe("welcome-email");
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
  });

  it("adds the cost with no org/user identity", async () => {
    await addPlatformCosts("platform-run-1", [
      { costName: "postmark-email-send", quantity: 1, costSource: "platform" },
    ]);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/platform-runs/platform-run-1/costs");
    const headers = headersOf(0);
    expect(headers["x-service-name"]).toBe("postmark-service");
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("closes the run with no org/user identity", async () => {
    await updatePlatformRun("platform-run-1", "completed");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/platform-runs/platform-run-1");
    expect(init.method).toBe("PATCH");
    const headers = headersOf(0);
    expect(headers["x-service-name"]).toBe("postmark-service");
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("fails loud when runs-service rejects a platform run", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "Unknown cost: postmark-email-send",
    });

    await expect(
      addPlatformCosts("platform-run-1", [
        { costName: "postmark-email-send", quantity: 1, costSource: "platform" },
      ])
    ).rejects.toThrow("422");
  });
});
