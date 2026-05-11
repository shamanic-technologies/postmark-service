import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEmailGatewayConfig } from "../../src/lib/email-gateway-client";

describe("validateEmailGatewayConfig", () => {
  const originalUrl = process.env.EMAIL_GATEWAY_URL;
  const originalKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;

  beforeEach(() => {
    delete process.env.EMAIL_GATEWAY_URL;
    delete process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  });

  afterEach(() => {
    if (originalUrl !== undefined) {
      process.env.EMAIL_GATEWAY_URL = originalUrl;
    } else {
      delete process.env.EMAIL_GATEWAY_URL;
    }
    if (originalKey !== undefined) {
      process.env.EMAIL_GATEWAY_SERVICE_API_KEY = originalKey;
    } else {
      delete process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
    }
  });

  it("throws when EMAIL_GATEWAY_URL is missing", () => {
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "secret";
    expect(() => validateEmailGatewayConfig()).toThrow(/EMAIL_GATEWAY_URL/);
  });

  it("throws when EMAIL_GATEWAY_SERVICE_API_KEY is missing", () => {
    process.env.EMAIL_GATEWAY_URL = "http://localhost:3009";
    expect(() => validateEmailGatewayConfig()).toThrow(
      /EMAIL_GATEWAY_SERVICE_API_KEY/
    );
  });

  it("throws when both are missing", () => {
    expect(() => validateEmailGatewayConfig()).toThrow();
  });

  it("does not throw when both are set", () => {
    process.env.EMAIL_GATEWAY_URL = "http://localhost:3009";
    process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "secret";
    expect(() => validateEmailGatewayConfig()).not.toThrow();
  });
});
