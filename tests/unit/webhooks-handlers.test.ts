import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module
vi.mock("../../src/db", () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  },
}));

import { db } from "../../src/db";
import {
  createDeliveryPayload,
  createBouncePayload,
  createOpenPayload,
  createClickPayload,
  createSpamComplaintPayload,
  createSubscriptionChangePayload,
} from "../fixtures/postmark-payloads";

describe("Webhook Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Payload parsing", () => {
    it("should parse delivery payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createDeliveryPayload(messageId);

      expect(payload.RecordType).toBe("Delivery");
      expect(payload.MessageID).toBe(messageId);
      expect(payload.Recipient).toBe("test@example.com");
    });

    it("should parse bounce payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createBouncePayload(12345, messageId);

      expect(payload.RecordType).toBe("Bounce");
      expect(payload.ID).toBe(12345);
      expect(payload.Type).toBe("HardBounce");
      expect(payload.TypeCode).toBe(1);
    });

    it("should parse open payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createOpenPayload(messageId);

      expect(payload.RecordType).toBe("Open");
      expect(payload.FirstOpen).toBe(true);
      expect(payload.Platform).toBe("Desktop");
    });

    it("should parse click payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createClickPayload(messageId);

      expect(payload.RecordType).toBe("Click");
      expect(payload.OriginalLink).toBe("https://example.com/cta");
      expect(payload.ClickLocation).toBe("HTML");
    });

    it("should parse spam complaint payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createSpamComplaintPayload(messageId);

      expect(payload.RecordType).toBe("SpamComplaint");
      expect(payload.Email).toBe("complainer@example.com");
    });

    it("should parse subscription change payload correctly", () => {
      const messageId = crypto.randomUUID();
      const payload = createSubscriptionChangePayload(messageId);

      expect(payload.RecordType).toBe("SubscriptionChange");
      expect(payload.SuppressSending).toBe(true);
      expect(payload.Origin).toBe("Recipient");
    });
  });

  describe("Date parsing", () => {
    it("should handle ISO date strings", () => {
      const dateStr = "2026-01-30T12:00:00Z";
      const date = new Date(dateStr);

      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth()).toBe(0); // January
      expect(date.getDate()).toBe(30);
    });
  });
});
