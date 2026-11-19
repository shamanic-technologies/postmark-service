import { describe, it, expect, vi, afterEach } from "vitest";
import {
  amzDate,
  canonicalUri,
  buildSesSendBody,
  encodeDisplayName,
  addressDomain,
  parseSesCredentials,
  sesSendEmail,
  signAwsRequest,
  splitAddressList,
} from "../../src/lib/ses-client";

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1" };

describe("parseSesCredentials", () => {
  it("reads the key-service JSON", () => {
    expect(
      parseSesCredentials(JSON.stringify({ ...creds, account: "distribute-transactional" }))
    ).toEqual(creds);
  });
  it("fails loud on a missing field or non-JSON (never a default region)", () => {
    expect(() => parseSesCredentials(JSON.stringify({ accessKeyId: "a", secretAccessKey: "b" }))).toThrow(/region/);
    expect(() => parseSesCredentials("nope")).toThrow(/not JSON/);
  });
});

describe("signAwsRequest (SigV4)", () => {
  const now = new Date("2015-08-30T12:36:00Z");
  it("formats x-amz-date", () => {
    expect(amzDate(now)).toBe("20150830T123600Z");
  });
  it("signs content-type, host, x-amz-date with the dated scope; deterministic", () => {
    const args = { method: "POST", host: "email.us-east-1.amazonaws.com", path: "/v2/email/outbound-emails", body: "{}", service: "ses", creds, now };
    const a = signAwsRequest(args);
    expect(a.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/
    );
    expect(signAwsRequest(args).authorization).toBe(a.authorization);
    expect(signAwsRequest({ ...args, body: "{\"x\":1}" }).authorization).not.toBe(a.authorization);
  });
});

describe("canonicalUri", () => {
  it("double-encodes an encoded segment, leaves a plain path alone", () => {
    expect(canonicalUri("/v2/email/outbound-emails")).toBe("/v2/email/outbound-emails");
    expect(canonicalUri("/v2/email/suppression/addresses/a%2Bb%40x.com")).toBe("/v2/email/suppression/addresses/a%252Bb%2540x.com");
  });
});

describe("addresses", () => {
  it("splits a list, keeping commas inside quotes and angle brackets", () => {
    expect(splitAddressList('a@x.com, "Doe, Jane" <j@y.com>,b@z.com')).toEqual([
      "a@x.com",
      '"Doe, Jane" <j@y.com>',
      "b@z.com",
    ]);
    expect(splitAddressList(undefined)).toEqual([]);
  });
  it("encodes a non-ASCII display name (RFC 2047), leaves ASCII untouched", () => {
    expect(encodeDisplayName("Équipe <a@x.com>")).toBe(
      `=?UTF-8?B?${Buffer.from("Équipe").toString("base64")}?= <a@x.com>`
    );
    expect(encodeDisplayName("Distribute <hello@distribute.you>")).toBe("Distribute <hello@distribute.you>");
  });
  it("reads the domain of a bare or named address, lowercased", () => {
    expect(addressDomain("Kevin <K@Distribute.You>")).toBe("distribute.you");
    expect(addressDomain("news@news.distribute.you")).toBe("news.distribute.you");
  });
});

describe("buildSesSendBody — same message as the Postmark send", () => {
  it("maps from, to, cc, bcc, reply-to, subject, html, text, headers, tag", () => {
    expect(
      buildSesSendBody({
        from: "Distribute <hello@distribute.you>",
        to: "a@x.com, b@y.com",
        cc: "c@x.com",
        bcc: "d@x.com",
        replyTo: "prospect@z.com",
        subject: "Your code",
        htmlBody: "<p>1</p>",
        textBody: "1",
        tag: "agent signup.code",
        headers: [{ name: "In-Reply-To", value: "<abc@x>" }],
      })
    ).toEqual({
      FromEmailAddress: "Distribute <hello@distribute.you>",
      Destination: { ToAddresses: ["a@x.com", "b@y.com"], CcAddresses: ["c@x.com"], BccAddresses: ["d@x.com"] },
      ReplyToAddresses: ["prospect@z.com"],
      Content: {
        Simple: {
          Subject: { Data: "Your code", Charset: "UTF-8" },
          Body: { Html: { Data: "<p>1</p>", Charset: "UTF-8" }, Text: { Data: "1", Charset: "UTF-8" } },
          Headers: [{ Name: "In-Reply-To", Value: "<abc@x>" }],
        },
      },
      EmailTags: [{ Name: "tag", Value: "agent_signup_code" }],
      ConfigurationSetName: "distribute-product-mail-events",
    });
  });
  it("adds no cc/bcc/reply-to/headers/tag the caller did not give (no recipient of our own)", () => {
    const b = buildSesSendBody({ from: "a@distribute.you", to: "x@y.com", subject: "s", textBody: "t" });
    expect(b).toEqual({
      FromEmailAddress: "a@distribute.you",
      Destination: { ToAddresses: ["x@y.com"] },
      Content: { Simple: { Subject: { Data: "s", Charset: "UTF-8" }, Body: { Text: { Data: "t", Charset: "UTF-8" } } } },
      // Every SES send publishes its bounces/complaints (ses-events.ts).
      ConfigurationSetName: "distribute-product-mail-events",
    });
  });
});

describe("buildSesSendBody — the gateway's unsubscribe footer keeps working", () => {
  const footer = '<a href="{{{pm:unsubscribe}}}">Unsubscribe</a>';
  it("swaps Postmark's merge tag for SES's own link, on our product-mail contact list", () => {
    const b = buildSesSendBody({
      from: "hello@distribute.you",
      to: "x@y.com",
      subject: "Welcome",
      htmlBody: `<p>Hi</p>${footer}`,
      textBody: "Unsubscribe: {{{ pm:unsubscribe }}}",
    }) as any;
    expect(b.Content.Simple.Body.Html.Data).toBe('<p>Hi</p><a href="{{amazonSESUnsubscribeUrl}}">Unsubscribe</a>');
    expect(b.Content.Simple.Body.Text.Data).toBe("Unsubscribe: {{amazonSESUnsubscribeUrl}}");
    expect(b.ListManagementOptions).toEqual({ ContactListName: "distribute-product-mail" });
  });
  it("a mail with no unsubscribe link carries no list (sign-up code)", () => {
    const b = buildSesSendBody({ from: "hello@distribute.you", to: "x@y.com", subject: "Code", htmlBody: "<p>123</p>" }) as any;
    expect(b.ListManagementOptions).toBeUndefined();
    expect(b.Content.Simple.Body.Html.Data).toBe("<p>123</p>");
  });
});

describe("sesSendEmail", () => {
  afterEach(() => vi.unstubAllGlobals());
  vi.spyOn(console, "error").mockImplementation(() => {});

  it("returns SES's MessageId on 200, signed POST to the SESv2 endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ MessageId: "0100abc-ses-id-000000" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sesSendEmail(creds, { from: "a@distribute.you", to: "x@y.com", subject: "s", textBody: "t" });
    expect(r).toMatchObject({ success: true, sesMessageId: "0100abc-ses-id-000000", errorCode: 0 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("is a failed send (never a throw, never a fallback) when SES refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"Email address is not verified."}', { status: 400 })));
    const r = await sesSendEmail(creds, { from: "a@distribute.you", to: "x@y.com", subject: "s", textBody: "t" });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe(400);
    expect(r.message).toMatch(/not verified/);
  });

  it("is a failed send when SES is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const r = await sesSendEmail(creds, { from: "a@distribute.you", to: "x@y.com", subject: "s", textBody: "t" });
    expect(r).toMatchObject({ success: false, errorCode: -1 });
    expect(r.message).toMatch(/ECONNRESET/);
  });
});
