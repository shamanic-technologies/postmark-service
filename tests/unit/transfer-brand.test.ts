import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransferBrandRequestSchema } from "../../src/schemas";

// Mock the db module before importing the route
vi.mock("../../src/db", () => ({
  db: {
    execute: vi.fn(),
  },
}));

import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/serviceAuth";
import transferRoutes from "../../src/routes/transfer";
import { db } from "../../src/db";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/internal", apiKeyAuth, transferRoutes);
  return app;
}

const headers = {
  "X-API-Key": process.env.POSTMARK_SERVICE_API_KEY || "test-secret-key",
  "Content-Type": "application/json",
};

describe("TransferBrandRequestSchema", () => {
  it("should accept valid input without targetBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-uuid",
      sourceOrgId: "source-org-uuid",
      targetOrgId: "target-org-uuid",
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid input with targetBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-uuid",
      sourceOrgId: "source-org-uuid",
      targetOrgId: "target-org-uuid",
      targetBrandId: "target-brand-uuid",
    });
    expect(result.success).toBe(true);
  });

  it("should reject missing sourceBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceOrgId: "source-org-uuid",
      targetOrgId: "target-org-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("should reject missing sourceOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-uuid",
      targetOrgId: "target-org-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("should reject missing targetOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-uuid",
      sourceOrgId: "source-org-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("should reject empty body", () => {
    const result = TransferBrandRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("POST /internal/transfer-brand", () => {
  const app = createApp();
  const mockExecute = db.execute as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: "b", sourceOrgId: "s", targetOrgId: "t" });

    expect(res.status).toBe(401);
  });

  it("should return 400 for invalid body", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId: "b" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("should execute step 1 only when no targetBrandId", async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 5 });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId: "brand-uuid", sourceOrgId: "src-org", targetOrgId: "tgt-org" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedTables: [{ tableName: "postmark_sendings", count: 5 }],
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("should execute two separate steps when targetBrandId present", async () => {
    // Step 1: move rows (org reassignment)
    mockExecute.mockResolvedValueOnce({ rowCount: 3 });
    // Step 2: rewrite brand references (no org filter)
    mockExecute.mockResolvedValueOnce({ rowCount: 5 });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({
        sourceBrandId: "brand-uuid",
        sourceOrgId: "src-org",
        targetOrgId: "tgt-org",
        targetBrandId: "new-brand-uuid",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedTables: [{ tableName: "postmark_sendings", count: 8 }],
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("should return count 0 when no rows match (idempotent)", async () => {
    mockExecute.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceBrandId: "brand-uuid", sourceOrgId: "src-org", targetOrgId: "tgt-org" });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables[0].count).toBe(0);
  });
});
