import { describe, it, expect, vi, afterEach } from "vitest";
import { countRecipients, planSesMessages, sesSendEmail, SES_MARKETING } from "../../src/lib/ses-client";

/**
 * SES-BCC-1127: SES refuses ListManagementOptions on a message with more than one
 * recipient (400 « There must be one Recipient when ListManagementOptions is set »).
 * Prod 2026-11-20..27: 17 customer mails blind-copied to the agency inbox failed.
 */
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", region: "us-east-1" };
const footer = '<p>Hi</p><a href="{{{pm:unsubscribe}}}">Unsubscribe</a>';
const base = { from: "Distribute <hello@distribute.you>", subject: "s", htmlBody: footer, textBody: "Stop: {{{pm:unsubscribe}}}" };

function recipients(m: Record<string, unknown>): string[] {
  const d = m.Destination as Record<string, string[]>;
  return [...(d.ToAddresses ?? []), ...(d.CcAddresses ?? []), ...(d.BccAddresses ?? [])];
}

describe("countRecipients", () => {
  it("counts every To, Cc and Bcc address (the billed units)", () => {
    expect(countRecipients({ to: "a@x.com" })).toBe(1);
    expect(countRecipients({ to: "a@x.com, b@x.com", cc: "c@x.com", bcc: '"Doe, J" <d@x.com>' })).toBe(4);
  });
});

describe("planSesMessages — single recipient unchanged", () => {
  it("one recipient with an unsubscribe link = one message with list management, as before", () => {
    const m = planSesMessages({ ...base, to: "client@acme.com" });
    expect(m).toHaveLength(1);
    expect(m[0].Destination).toEqual({ ToAddresses: ["client@acme.com"] });
    expect(m[0].ListManagementOptions).toEqual({ ContactListName: "distribute-product-mail" });
  });

  it("several recipients but no unsubscribe link = one message, every recipient on it", () => {
    const m = planSesMessages({ from: base.from, subject: "s", textBody: "code 123", to: "a@x.com", bcc: "b@x.com" });
    expect(m).toHaveLength(1);
    expect(m[0].Destination).toEqual({ ToAddresses: ["a@x.com"], BccAddresses: ["b@x.com"] });
    expect(m[0].ListManagementOptions).toBeUndefined();
  });
});

describe("planSesMessages — Bcc / Cc with an unsubscribe link", () => {
  it("To + Bcc = blind copy first (no list, link emptied), the person last with their unsubscribe", () => {
    const m = planSesMessages({ ...base, to: "kevin.lourd@gmail.com", bcc: "kevin@distribute.you" });
    expect(m).toHaveLength(2);
    const [copy, primary] = m;
    expect(copy.Destination).toEqual({ BccAddresses: ["kevin@distribute.you"] });
    expect(copy.ListManagementOptions).toBeUndefined();
    const copyBody = (copy.Content as any).Simple.Body;
    expect(copyBody.Html.Data).toBe('<p>Hi</p><a href="">Unsubscribe</a>');
    expect(copyBody.Text.Data).toBe("Stop: ");
    expect(primary.Destination).toEqual({ ToAddresses: ["kevin.lourd@gmail.com"] });
    expect(primary.ListManagementOptions).toEqual({ ContactListName: "distribute-product-mail" });
    expect((primary.Content as any).Simple.Body.Html.Data).toContain("{{amazonSESUnsubscribeUrl}}");
  });

  it("every message SES receives with a list carries exactly one recipient", () => {
    const m = planSesMessages({ ...base, to: "a@x.com, b@x.com", cc: "c@x.com, d@x.com", bcc: "e@x.com, f@x.com" });
    for (const msg of m) {
      if (msg.ListManagementOptions) expect(recipients(msg)).toHaveLength(1);
    }
    expect(m.flatMap(recipients).sort()).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"]);
    expect(m[m.length - 1].Destination).toEqual({ ToAddresses: ["a@x.com"] });
    expect(m.find((x) => (x.Destination as any).CcAddresses)?.Destination).toEqual({ CcAddresses: ["c@x.com"] });
  });

  it("keeps subject, reply-to, tag, configuration set on every message; the marketing list on the marketing account", () => {
    const m = planSesMessages({ ...base, to: "a@x.com", bcc: "b@x.com", replyTo: "r@x.com", tag: "credit-depleted" }, SES_MARKETING);
    for (const msg of m) {
      expect(msg.ReplyToAddresses).toEqual(["r@x.com"]);
      expect(msg.ConfigurationSetName).toBe("distribute-newsletter-events");
      expect(msg.EmailTags).toEqual([{ Name: "tag", Value: "credit-depleted" }]);
    }
    expect(m[1].ListManagementOptions).toEqual({ ContactListName: "distribute-newsletter" });
  });
});

describe("sesSendEmail — split send", () => {
  afterEach(() => vi.unstubAllGlobals());
  vi.spyOn(console, "error").mockImplementation(() => {});

  it("sends each message; the primary's id is the send's, the copies' ids are returned apart", async () => {
    const ids = ["copy-id", "primary-id"];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ MessageId: ids.shift() }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sesSendEmail(creds, { ...base, to: "kevin.lourd@gmail.com", bcc: "kevin@distribute.you" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ success: true, sesMessageId: "primary-id", copyMessageIds: ["copy-id"], errorCode: 0 });
  });

  it("a refused copy stops before the person's message: a failed send that never reached them", async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"nope"}', { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sesSendEmail(creds, { ...base, to: "kevin.lourd@gmail.com", bcc: "kevin@distribute.you" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: false, errorCode: 400 });
  });

  it("a refused primary after a copy went out names the copy in the failure", async () => {
    const answers = [new Response(JSON.stringify({ MessageId: "copy-id" }), { status: 200 }), new Response('{"message":"nope"}', { status: 400 })];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    const r = await sesSendEmail(creds, { ...base, to: "kevin.lourd@gmail.com", bcc: "kevin@distribute.you" });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/after 1 of 2 copies went out: copy-id/);
  });

  it("a single-recipient send is one call with no copy ids (unchanged)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ MessageId: "only" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await sesSendEmail(creds, { ...base, to: "client@acme.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: true, sesMessageId: "only", copyMessageIds: [] });
  });
});
