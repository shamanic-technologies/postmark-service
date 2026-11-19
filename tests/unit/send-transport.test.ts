import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "org-run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
  createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-1" }),
  updatePlatformRun: vi.fn().mockResolvedValue({}),
  addPlatformCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/lib/postmark-client", () => ({
  sendEmail: vi.fn().mockResolvedValue({
    success: true,
    messageId: "22222222-2222-4222-8222-222222222222",
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  }),
  sendEmailWithToken: vi.fn().mockResolvedValue({
    success: true,
    messageId: "33333333-3333-4333-8333-333333333333",
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  }),
}));

const SES_CREDS = JSON.stringify({ accessKeyId: "AKID", secretAccessKey: "secret", region: "us-east-1", account: "distribute-transactional" });

vi.mock("../../src/lib/key-client", () => ({
  getOrgKey: vi.fn().mockResolvedValue({ provider: "postmark", key: "platform-token", keySource: "platform" }),
  getStreamId: vi.fn(async (_o: string, _u: string, type: string) => `${type}-stream-id`),
  getFromAddress: vi.fn().mockResolvedValue("Distribute <hello@distribute.you>"),
  getPlatformKey: vi.fn(async (provider: string) =>
    provider.startsWith("aws-ses-") ? SES_CREDS : `platform:${provider}`
  ),
}));

vi.mock("../../src/lib/ses-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/ses-client")>()),
  sesSendEmail: vi.fn().mockResolvedValue({
    success: true,
    sesMessageId: "0100018c-ses-message-id-000000",
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  }),
}));

vi.mock("../../src/lib/marketing-ramp", () => ({
  marketingRampAllows: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/lib/billing-client", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 500, required_cents: 1 }),
}));

const insertValues = vi.fn((_v: Record<string, unknown>) => ({ returning: vi.fn(() => [{ id: "sending-1" }]) }));
vi.mock("../../src/db", () => ({
  db: { insert: vi.fn(() => ({ values: insertValues })) },
}));

vi.mock("../../src/lib/silver", () => ({
  upsertSilver: vi.fn().mockResolvedValue(undefined),
}));

import {
  chooseSendTransport,
  costNameFor,
  platformSendProvider,
  KILL_SWITCH_ENV,
  MARKETING_KILL_SWITCH_ENV,
  marketingSendProvider,
} from "../../src/lib/send-transport";
import { marketingRampAllows } from "../../src/lib/marketing-ramp";
import { SES_MARKETING, SES_TRANSACTIONAL } from "../../src/lib/ses-client";
import { sesSendEmail } from "../../src/lib/ses-client";
import { sendEmail, sendEmailWithToken } from "../../src/lib/postmark-client";
import { getFromAddress, getOrgKey, getPlatformKey } from "../../src/lib/key-client";
import { addCosts, addPlatformCosts } from "../../src/lib/runs-client";
import { authorizeCredits } from "../../src/lib/billing-client";
import request from "supertest";
import { createTestApp, getAuthHeaders, getServiceHeaders } from "../helpers/test-app";

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("chooseSendTransport — which sends SES carries", () => {
  it("our product mail (platform key, From @distribute.you) = SES", () => {
    expect(chooseSendTransport({ keySource: "platform", from: "hello@distribute.you" }, {})).toBe("ses");
    expect(chooseSendTransport({ keySource: "platform", from: "Distribute <Hello@Distribute.YOU>" }, {})).toBe("ses");
  });
  it("the newsletter domain goes to the MARKETING SES account, never the transactional one", () => {
    expect(chooseSendTransport({ keySource: "platform", from: "Kevin <kevin@news.distribute.you>" }, {})).toBe("ses-marketing");
    // The product-mail kill switch does not move the newsletter, and vice versa.
    expect(chooseSendTransport({ keySource: "platform", from: "kevin@news.distribute.you" }, { [KILL_SWITCH_ENV]: "postmark" })).toBe("ses-marketing");
    expect(chooseSendTransport({ keySource: "platform", from: "hello@distribute.you" }, { [MARKETING_KILL_SWITCH_ENV]: "postmark" })).toBe("ses");
  });
  it("newsletter kill switch MARKETING_SEND_PROVIDER=postmark puts it back on Postmark; unknown value fails loud", () => {
    expect(chooseSendTransport({ keySource: "platform", from: "kevin@news.distribute.you" }, { [MARKETING_KILL_SWITCH_ENV]: "postmark" })).toBe("postmark");
    expect(() => marketingSendProvider({ [MARKETING_KILL_SWITCH_ENV]: "mailchimp" })).toThrow(/neither/);
  });
  it("an org's own Postmark key, or another domain, stays on Postmark", () => {
    expect(chooseSendTransport({ keySource: "org", from: "hello@distribute.you" }, {})).toBe("postmark");
    expect(chooseSendTransport({ keySource: "platform", from: "hi@client.com" }, {})).toBe("postmark");
  });
  it("kill switch PLATFORM_SEND_PROVIDER=postmark puts every one back on Postmark", () => {
    expect(chooseSendTransport({ keySource: "platform", from: "hello@distribute.you" }, { [KILL_SWITCH_ENV]: "postmark" })).toBe("postmark");
    expect(platformSendProvider({ [KILL_SWITCH_ENV]: "SES" })).toBe("ses");
    expect(platformSendProvider({})).toBe("ses");
  });
  it("an unknown kill-switch value fails loud", () => {
    expect(() => platformSendProvider({ [KILL_SWITCH_ENV]: "sendgrid" })).toThrow(/neither/);
  });
  it("each provider declares its own cost name", () => {
    expect(costNameFor("ses")).toBe("ses-email-send");
    expect(costNameFor("postmark")).toBe("postmark-email-send");
  });
});

describe("routes — product mail leaves through SES", () => {
  const app = createTestApp();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[KILL_SWITCH_ENV];
  });
  afterEach(() => {
    delete process.env[KILL_SWITCH_ENV];
  });

  const msg = {
    to: "user@example.com",
    subject: "Welcome",
    htmlBody: "<p>Hi</p>",
    textBody: "Hi",
    replyTo: "support@distribute.you",
    bcc: "staff@distribute.you",
    tag: "welcome",
    headers: [{ name: "X-Entity-Ref-ID", value: "abc" }],
    payer: "platform",
  };

  it("/orgs/send: same message through SES, Postmark untouched, row + cost name ses", async () => {
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(msg);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, provider: "ses", providerMessageId: "0100018c-ses-message-id-000000", sendingId: "sending-1" });
    expect(res.body.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendEmail).not.toHaveBeenCalled();

    const [, sesParams] = vi.mocked(sesSendEmail).mock.calls[0];
    expect(sesParams).toMatchObject({
      from: "Distribute <hello@distribute.you>",
      to: "user@example.com",
      bcc: "staff@distribute.you",
      replyTo: "support@distribute.you",
      subject: "Welcome",
      htmlBody: "<p>Hi</p>",
      textBody: "Hi",
      tag: "welcome",
      headers: [{ name: "X-Entity-Ref-ID", value: "abc" }],
    });

    const row = insertValues.mock.calls[0][0];
    expect(row).toMatchObject({
      provider: "ses",
      providerMessageId: "0100018c-ses-message-id-000000",
      messageId: res.body.messageId,
      messageStream: null,
      payer: "platform",
    });

    await flush();
    expect(addPlatformCosts).toHaveBeenCalledWith(
      "platform-run-1",
      [{ costName: "ses-email-send", quantity: 1, costSource: "platform", idempotencyKey: "postmark-email-send:sending-1" }],
      expect.any(Object)
    );
  });

  it("/orgs/send org-paid product mail authorizes ses-email-send", async () => {
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send({ ...msg, payer: "org", tag: "goal_launched" });
    expect(res.status).toBe(200);
    expect(vi.mocked(authorizeCredits).mock.calls[0][0].items).toEqual([{ costName: "ses-email-send", quantity: 1 }]);
    await flush();
    expect(vi.mocked(addCosts).mock.calls[0][1]).toEqual([
      { costName: "ses-email-send", quantity: 1, costSource: "platform", idempotencyKey: "postmark-email-send:sending-1" },
    ]);
  });

  it("/orgs/send newsletter (news.distribute.you) leaves through the MARKETING SES account", async () => {
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...msg, from: "Kevin <kevin@news.distribute.you>", tag: "mailing-list-release-x", payer: "org" });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("ses-marketing");
    expect(sendEmail).not.toHaveBeenCalled();
    const [, , account] = vi.mocked(sesSendEmail).mock.calls[0];
    expect(account).toBe(SES_MARKETING);
    expect(account).not.toBe(SES_TRANSACTIONAL);
    expect(vi.mocked(getPlatformKey).mock.calls.map((c) => c[0])).toContain("aws-ses-marketing");
    expect(vi.mocked(getPlatformKey).mock.calls.map((c) => c[0])).not.toContain("aws-ses-transactional");
    expect(insertValues.mock.calls[0][0]).toMatchObject({ provider: "ses-marketing", messageStream: null });
    expect(vi.mocked(authorizeCredits).mock.calls[0][0].items).toEqual([{ costName: "ses-email-send", quantity: 1 }]);
  });

  it("/orgs/send newsletter over today's ramp cap stays on Postmark broadcast (planned split)", async () => {
    vi.mocked(marketingRampAllows).mockResolvedValueOnce(false);
    const res = await request(app)
      .post("/orgs/send")
      .set(getAuthHeaders())
      .send({ ...msg, from: "kevin@news.distribute.you", tag: "mailing-list-release-x" });
    expect(res.status).toBe(200);
    expect(sesSendEmail).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0][0]).toMatchObject({ provider: "postmark", messageStream: "broadcast-stream-id" });
  });

  it("an SES marketing refusal is a failed send, never Postmark", async () => {
    vi.mocked(sesSendEmail).mockResolvedValueOnce({ success: false, errorCode: 400, message: "SES 400: Throttling" });
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send({ ...msg, from: "kevin@news.distribute.you" });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("/orgs/send with an org's own Postmark key stays on Postmark", async () => {
    vi.mocked(getOrgKey).mockResolvedValueOnce({ provider: "postmark", key: "org-token", keySource: "org" });
    await request(app).post("/orgs/send").set(getAuthHeaders()).send(msg);
    expect(sesSendEmail).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("kill switch: PLATFORM_SEND_PROVIDER=postmark sends product mail through Postmark again", async () => {
    process.env[KILL_SWITCH_ENV] = "postmark";
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(msg);
    expect(res.status).toBe(200);
    expect(sesSendEmail).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("an SES refusal is a failed send: no fallback to Postmark, run failed, no cost", async () => {
    vi.mocked(sesSendEmail).mockResolvedValueOnce({ success: false, errorCode: 400, message: "SES 400: MessageRejected" });
    const res = await request(app).post("/orgs/send").set(getAuthHeaders()).send(msg);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorCode: 400 });
    expect(sendEmail).not.toHaveBeenCalled();
    await flush();
    expect(addPlatformCosts).not.toHaveBeenCalled();
  });

  it("/orgs/send/batch splits per email: product mail via SES, another domain via Postmark, authorize per cost name", async () => {
    vi.mocked(getFromAddress).mockResolvedValueOnce("hello@distribute.you");
    const res = await request(app)
      .post("/orgs/send/batch")
      .set(getAuthHeaders())
      .send({
        emails: [
          { to: "a@x.com", subject: "s", textBody: "t", payer: "org" },
          { to: "b@x.com", subject: "s", textBody: "t", payer: "org", from: "hi@client.com" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: true, provider: "ses", providerMessageId: "0100018c-ses-message-id-000000" });
    expect(res.body.results[1].provider).toBeUndefined();
    expect(sesSendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authorizeCredits).mock.calls[0][0].items).toEqual([
      { costName: "ses-email-send", quantity: 1 },
      { costName: "postmark-email-send", quantity: 1 },
    ]);
  });

  it("/internal/platform-send (sign-up code) goes through SES with the platform from", async () => {
    const res = await request(app)
      .post("/internal/platform-send")
      .set(getServiceHeaders())
      .send({ payer: "platform", to: "new@x.com", subject: "Your code", textBody: "123456", tag: "agent_signup_code", stream: "transactional", from: "Distribute <hello@distribute.you>" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: "ses", providerMessageId: "0100018c-ses-message-id-000000", runId: "platform-run-1" });
    expect(sendEmailWithToken).not.toHaveBeenCalled();
    expect(insertValues.mock.calls[0][0]).toMatchObject({ provider: "ses", orgId: null, payer: "platform" });
    await flush();
    expect(vi.mocked(addPlatformCosts).mock.calls[0][1][0].costName).toBe("ses-email-send");
  });

  it("/internal/platform-send SES refusal = 502 SES_REJECTED, never Postmark", async () => {
    vi.mocked(sesSendEmail).mockResolvedValueOnce({ success: false, errorCode: 400, message: "SES 400: nope" });
    const res = await request(app)
      .post("/internal/platform-send")
      .set(getServiceHeaders())
      .send({ payer: "platform", to: "new@x.com", subject: "c", textBody: "1", from: "hello@distribute.you" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("SES_REJECTED");
    expect(sendEmailWithToken).not.toHaveBeenCalled();
  });
});
