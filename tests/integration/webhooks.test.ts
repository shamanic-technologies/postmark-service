import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";
import { cleanTestData, closeDb, randomUUID } from "../helpers/test-db";
import { db } from "../../src/db";
import { postmarkDeliveries, postmarkBounces, postmarkOpenings, postmarkLinkClicks } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  createDeliveryPayload,
  createBouncePayload,
  createOpenPayload,
  createClickPayload,
  createInvalidPayload,
} from "../fixtures/postmark-payloads";

describe("Webhooks Integration", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("POST /webhooks/postmark", () => {
    it("should handle Delivery webhook and insert into database", async () => {
      const messageId = randomUUID();
      const payload = createDeliveryPayload(messageId);

      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.recordType).toBe("Delivery");

      // Verify inserted in database
      const [delivery] = await db
        .select()
        .from(postmarkDeliveries)
        .where(eq(postmarkDeliveries.messageId, messageId));

      expect(delivery).toBeDefined();
      expect(delivery.recipient).toBe("test@example.com");
      expect(delivery.recordType).toBe("Delivery");
    });

    it("should handle Bounce webhook and insert into database", async () => {
      const messageId = randomUUID();
      const bounceId = Math.floor(Math.random() * 1000000000);
      const payload = createBouncePayload(bounceId, messageId);

      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.recordType).toBe("Bounce");

      // Verify inserted in database
      const [bounce] = await db
        .select()
        .from(postmarkBounces)
        .where(eq(postmarkBounces.messageId, messageId));

      expect(bounce).toBeDefined();
      expect(bounce.type).toBe("HardBounce");
      expect(bounce.email).toBe("bounced@example.com");
    });

    it("should handle Open webhook and insert into database", async () => {
      const messageId = randomUUID();
      const payload = createOpenPayload(messageId);

      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.recordType).toBe("Open");

      // Verify inserted in database
      const [opening] = await db
        .select()
        .from(postmarkOpenings)
        .where(eq(postmarkOpenings.messageId, messageId));

      expect(opening).toBeDefined();
      expect(opening.firstOpen).toBe(true);
      expect(opening.platform).toBe("Desktop");
    });

    it("should handle Click webhook and insert into database", async () => {
      const messageId = randomUUID();
      const payload = createClickPayload(messageId);

      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.recordType).toBe("Click");

      // Verify inserted in database
      const [click] = await db
        .select()
        .from(postmarkLinkClicks)
        .where(eq(postmarkLinkClicks.messageId, messageId));

      expect(click).toBeDefined();
      expect(click.originalLink).toBe("https://example.com/cta");
    });

    it("should handle duplicate deliveries with onConflictDoNothing", async () => {
      const messageId = randomUUID();
      const payload = createDeliveryPayload(messageId);

      // Send first webhook
      await request(app).post("/webhooks/postmark").send(payload);

      // Send duplicate
      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(200);

      // Should still only have one record
      const deliveries = await db
        .select()
        .from(postmarkDeliveries)
        .where(eq(postmarkDeliveries.messageId, messageId));

      expect(deliveries.length).toBe(1);
    });

    it("should reject payloads without RecordType", async () => {
      const payload = createInvalidPayload();

      const response = await request(app)
        .post("/webhooks/postmark")
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Missing RecordType");
    });
  });
});
