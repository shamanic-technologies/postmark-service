import { describe, it, expect } from "vitest";
import { normalizeSslMode } from "../../src/db/utils";

describe("normalizeSslMode", () => {
  it("replaces sslmode=require with verify-full", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=require";
    expect(normalizeSslMode(url)).toBe(
      "postgresql://user:pass@host:5432/db?sslmode=verify-full"
    );
  });

  it("replaces sslmode=prefer with verify-full", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=prefer";
    expect(normalizeSslMode(url)).toBe(
      "postgresql://user:pass@host:5432/db?sslmode=verify-full"
    );
  });

  it("replaces sslmode=verify-ca with verify-full", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=verify-ca";
    expect(normalizeSslMode(url)).toBe(
      "postgresql://user:pass@host:5432/db?sslmode=verify-full"
    );
  });

  it("leaves sslmode=verify-full unchanged", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=verify-full";
    expect(normalizeSslMode(url)).toBe(url);
  });

  it("leaves sslmode=disable unchanged", () => {
    const url = "postgresql://user:pass@host:5432/db?sslmode=disable";
    expect(normalizeSslMode(url)).toBe(url);
  });

  it("handles sslmode in the middle of query params", () => {
    const url = "postgresql://host/db?connect_timeout=10&sslmode=require&application_name=app";
    expect(normalizeSslMode(url)).toBe(
      "postgresql://host/db?connect_timeout=10&sslmode=verify-full&application_name=app"
    );
  });

  it("handles URLs without sslmode", () => {
    const url = "postgresql://user:pass@host:5432/db";
    expect(normalizeSslMode(url)).toBe(url);
  });
});
