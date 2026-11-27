import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";

const selected: { rows: unknown[]; queue?: unknown[][] } = { rows: [{ messageId: "11111111-1111-4111-8111-111111111111", tag: "welcome" }] };
const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
vi.mock("../../src/db", () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => (selected.queue?.length ? selected.queue.shift() : selected.rows) }) }) })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return { onConflictDoNothing: async () => undefined };
      },
    })),
  },
}));
vi.mock("../../src/lib/silver", () => ({ upsertSilver: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/key-client", () => ({ getPlatformKey: vi.fn(async (p: string) => (p === "postmark" ? "pm-token" : "broadcast")) }));

import {
  bounceTypeOf,
  clearSnsCertCacheForTests,
  recordSesEvent,
  sesBounceId,
  snsStringToSign,
  verifySnsMessage,
  SnsMessage,
} from "../../src/lib/ses-events";
import { SES_EVENTS_TOPIC_ARN, SES_MARKETING } from "../../src/lib/ses-client";
import { postmarkBounces, postmarkSpamComplaints, postmarkDeliveries } from "../../src/db/schema";
import { upsertSilver } from "../../src/lib/silver";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";

function signed(m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">): SnsMessage {
  const full = { ...m, SignatureVersion: "2", SigningCertURL: CERT_URL, Signature: "" } as SnsMessage;
  const s = createSign("RSA-SHA256");
  s.update(snsStringToSign(full));
  full.Signature = s.sign(privateKey, "base64");
  return full;
}

const sesBounce = {
  eventType: "Bounce",
  mail: { messageId: "0100-ses-1", source: "growth@distribute.you", destination: ["bounce@simulator.amazonses.com"], commonHeaders: { subject: "Hi" } },
  bounce: {
    bounceType: "Permanent",
    bounceSubType: "General",
    feedbackId: "fb-1",
    timestamp: "2026-11-19T12:00:00.000Z",
    bouncedRecipients: [{ emailAddress: "bounce@simulator.amazonses.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" }],
  },
};

const notification = (msg: object) =>
  signed({ Type: "Notification", MessageId: "sns-1", TopicArn: SES_EVENTS_TOPIC_ARN, Message: JSON.stringify(msg), Timestamp: "2026-11-19T12:00:01.000Z" });

describe("SNS verification", () => {
  beforeEach(() => {
    clearSnsCertCacheForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(publicKey.export({ type: "spki", format: "pem" }) as string)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a genuine message of our topic", async () => {
    await expect(verifySnsMessage(notification(sesBounce))).resolves.toBeUndefined();
  });
  it("refuses a tampered message", async () => {
    const m = notification(sesBounce);
    await expect(verifySnsMessage({ ...m, Message: m.Message.replace("Permanent", "Transient") })).rejects.toThrow(/signature/);
  });
  it("refuses another topic, even correctly signed (anyone can aim their topic at us)", async () => {
    const m = signed({ Type: "Notification", MessageId: "x", TopicArn: "arn:aws:sns:us-east-1:999999999999:theirs", Message: "{}", Timestamp: "t" });
    await expect(verifySnsMessage(m)).rejects.toThrow(/not ours/);
  });
  it("refuses a cert hosted anywhere but sns.<region>.amazonaws.com", async () => {
    const m = { ...notification(sesBounce), SigningCertURL: "https://evil.example.com/x.pem" };
    await expect(verifySnsMessage(m)).rejects.toThrow(/not an AWS SNS URL/);
  });
});

describe("recordSesEvent → the same bronze tables as Postmark", () => {
  beforeEach(() => {
    inserted.length = 0;
    vi.clearAllMocks();
    selected.rows = [{ messageId: "11111111-1111-4111-8111-111111111111", tag: "welcome" }];
  });

  it("a bounce lands in postmark_bounces on OUR message id, then silver", async () => {
    expect(await recordSesEvent(JSON.stringify(sesBounce))).toBe("recorded");
    expect(inserted[0].table).toBe(postmarkBounces);
    expect(inserted[0].values).toMatchObject({
      id: sesBounceId("fb-1", "bounce@simulator.amazonses.com"),
      type: "HardBounce",
      messageId: "11111111-1111-4111-8111-111111111111",
      email: "bounce@simulator.amazonses.com",
      inactive: true,
      messageStream: "ses",
      tag: "welcome",
    });
    expect(upsertSilver).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("a complaint lands in postmark_spam_complaints", async () => {
    await recordSesEvent(
      JSON.stringify({
        eventType: "Complaint",
        mail: { messageId: "0100-ses-1" },
        complaint: { feedbackId: "fb-2", timestamp: "2026-11-19T12:00:00.000Z", complainedRecipients: [{ emailAddress: "complaint@simulator.amazonses.com" }] },
      })
    );
    expect(inserted[0].table).toBe(postmarkSpamComplaints);
    expect(inserted[0].values).toMatchObject({ email: "complaint@simulator.amazonses.com", messageStream: "ses" });
  });

  it("a delivery lands in postmark_deliveries", async () => {
    await recordSesEvent(JSON.stringify({ eventType: "Delivery", mail: { messageId: "0100-ses-1" }, delivery: { timestamp: "2026-11-19T12:00:00.000Z", recipients: ["a@x.com"] } }));
    expect(inserted[0].table).toBe(postmarkDeliveries);
  });

  it("an event for a message we never sent records nothing", async () => {
    selected.rows = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordSesEvent(JSON.stringify(sesBounce))).toBe("unknown_message");
    expect(inserted).toHaveLength(0);
  });

  it("an event for the blind copy of a split send (SES-BCC-1127) is recognised and records nothing", async () => {
    selected.queue = [[], [{ messageId: "11111111-1111-4111-8111-111111111111" }]];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const delivery = { eventType: "Delivery", mail: { messageId: "0100-copy-1", destination: ["kevin@distribute.you"] }, delivery: { timestamp: "2026-11-27T12:00:00.000Z", recipients: ["kevin@distribute.you"] } };
    expect(await recordSesEvent(JSON.stringify(delivery))).toBe("ignored");
    expect(inserted).toHaveLength(0);
    expect(log.mock.calls.flat().join(" ")).toMatch(/copy 0100-copy-1 \(to=kevin@distribute.you\)/);
    selected.queue = undefined;
  });

  it("bounce ids: negative (never a Postmark id), stable per feedback + recipient", () => {
    expect(sesBounceId("fb", "A@x.com")).toBeLessThan(0);
    expect(sesBounceId("fb", "a@x.com")).toBe(sesBounceId("fb", "A@x.com"));
    expect(bounceTypeOf("Transient")).toBe("SoftBounce");
  });
});

describe("POST /webhooks/ses", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    inserted.length = 0;
    clearSnsCertCacheForTests();
    fetchMock = vi.fn(async (url: string) =>
      url === CERT_URL ? new Response(publicKey.export({ type: "spki", format: "pem" }) as string) : new Response("<ok/>")
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a signed bounce sent as text/plain (how SNS posts)", async () => {
    const res = await request(app).post("/webhooks/ses").set("content-type", "text/plain; charset=UTF-8").send(JSON.stringify(notification(sesBounce)));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("recorded");
    expect(inserted[0].table).toBe(postmarkBounces);
  });

  it("403 and nothing recorded on a bad signature", async () => {
    const m = notification(sesBounce);
    const res = await request(app).post("/webhooks/ses").set("content-type", "text/plain").send(JSON.stringify({ ...m, Signature: "AAAA" }));
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("confirms the subscription of OUR topic by GETting its SubscribeURL", async () => {
    const sub = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";
    const m = signed({ Type: "SubscriptionConfirmation", MessageId: "m", TopicArn: SES_EVENTS_TOPIC_ARN, Message: "confirm", Timestamp: "t", SubscribeURL: sub, Token: "t" });
    const res = await request(app).post("/webhooks/ses").set("content-type", "text/plain").send(JSON.stringify(m));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain(sub);
  });
});

describe("newsletter (marketing account) opt-outs reach Postmark's broadcast suppression list", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    inserted.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("accepts the marketing account's topic", async () => {
    clearSnsCertCacheForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(publicKey.export({ type: "spki", format: "pem" }) as string)));
    const m = signed({ Type: "Notification", MessageId: "n", TopicArn: SES_MARKETING.topicArn, Message: "{}", Timestamp: "t" });
    await expect(verifySnsMessage(m)).resolves.toBeUndefined();
  });

  it("a permanent bounce of an SES newsletter is recorded AND suppressed on Postmark broadcast", async () => {
    selected.rows = [{ messageId: "22222222-2222-4222-8222-222222222222", tag: "mailing-list-release-x", provider: "ses-marketing" }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ Suppressions: [{ EmailAddress: "bounce@simulator.amazonses.com", Status: "Suppressed" }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await recordSesEvent(JSON.stringify(sesBounce))).toBe("recorded");
    expect(inserted[0].table).toBe(postmarkBounces);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.postmarkapp.com/message-streams/broadcast/suppressions");
    expect(JSON.parse(init.body as string)).toEqual({ Suppressions: [{ EmailAddress: "bounce@simulator.amazonses.com" }] });
  });

  it("an unsubscribe of an SES newsletter is suppressed on Postmark broadcast", async () => {
    selected.rows = [{ messageId: "22222222-2222-4222-8222-222222222222", tag: "t", provider: "ses-marketing" }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ Suppressions: [{ EmailAddress: "a@x.com", Status: "Suppressed" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await recordSesEvent(JSON.stringify({ eventType: "Subscription", mail: { messageId: "m", destination: ["a@x.com"] }, subscription: { newTopicPreferences: { unsubscribeAll: true } } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Postmark refusing the suppression fails loud (SNS retries)", async () => {
    selected.rows = [{ messageId: "22222222-2222-4222-8222-222222222222", tag: "t", provider: "ses-marketing" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Suppressions: [{ EmailAddress: "x", Status: "Failed", Message: "nope" }] }))));
    await expect(recordSesEvent(JSON.stringify(sesBounce))).rejects.toThrow(/refused/);
  });

  it("product mail (transactional account) writes nothing to Postmark", async () => {
    selected.rows = [{ messageId: "11111111-1111-4111-8111-111111111111", tag: "welcome", provider: "ses" }];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await recordSesEvent(JSON.stringify(sesBounce));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
