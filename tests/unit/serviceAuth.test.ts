import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { apiKeyAuth, requireOrgId } from "../../src/middleware/serviceAuth";

function mockReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers };
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("serviceAuth middleware", () => {
  describe("apiKeyAuth", () => {
    beforeEach(() => {
      process.env.POSTMARK_SERVICE_API_KEY = "test-secret";
    });

    it("returns 401 if x-api-key header is missing", () => {
      const req = mockReq({});
      const res = mockRes();
      const next = vi.fn();

      apiKeyAuth(req as Request, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 if x-api-key is invalid", () => {
      const req = mockReq({ "x-api-key": "wrong" });
      const res = mockRes();
      const next = vi.fn();

      apiKeyAuth(req as Request, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it("calls next() if x-api-key is valid", () => {
      const req = mockReq({ "x-api-key": "test-secret" });
      const res = mockRes();
      const next = vi.fn();

      apiKeyAuth(req as Request, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe("requireOrgId", () => {
    it("returns 400 if x-org-id is missing", () => {
      const req = mockReq({});
      const res = mockRes();
      const next = vi.fn();

      requireOrgId(req as Request, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it("parses all identity headers into orgContext", () => {
      const req = mockReq({
        "x-org-id": "org-1",
        "x-user-id": "user-1",
        "x-run-id": "run-1",
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-a,brand-b",
        "x-feature-slug": "feat-1",
        "x-workflow-slug": "wf-1",
      });
      const res = mockRes();
      const next = vi.fn();

      requireOrgId(req as Request, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as any).orgContext).toEqual({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        campaignId: "camp-1",
        brandIds: ["brand-a", "brand-b"],
        featureSlug: "feat-1",
        workflowSlug: "wf-1",
      });
    });

    it("parses single brand ID into array", () => {
      const req = mockReq({
        "x-org-id": "org-1",
        "x-brand-id": "brand-a",
      });
      const res = mockRes();
      const next = vi.fn();

      requireOrgId(req as Request, res, next);

      expect((req as any).orgContext.brandIds).toEqual(["brand-a"]);
    });

    it("sets brandIds to undefined when header is absent", () => {
      const req = mockReq({
        "x-org-id": "org-1",
      });
      const res = mockRes();
      const next = vi.fn();

      requireOrgId(req as Request, res, next);

      expect((req as any).orgContext.brandIds).toBeUndefined();
    });

    it("trims whitespace from comma-separated brand IDs", () => {
      const req = mockReq({
        "x-org-id": "org-1",
        "x-brand-id": " brand-a , brand-b , brand-c ",
      });
      const res = mockRes();
      const next = vi.fn();

      requireOrgId(req as Request, res, next);

      expect((req as any).orgContext.brandIds).toEqual(["brand-a", "brand-b", "brand-c"]);
    });
  });
});
