import { createHash, createHmac } from "node:crypto";
import { messageOf } from "./db-error.js";

/**
 * Amazon SES (SESv2 `SendEmail`, Simple content) for our own product mail
 * (SES-PLATFORM-SENDS-1119, owner 2026-11-19 « switch all that we can on SES »).
 *
 * No AWS SDK: one signed HTTPS call (SigV4, AWS's documented algorithm) is all a
 * send needs, so the service carries no SDK. Which sends come here is decided in
 * `send-transport.ts`, never here.
 *
 * Credentials: key-service PLATFORM key `aws-ses-transactional`, a JSON string
 * `{"accessKeyId","secretAccessKey","region","account"}`.
 *
 * Fail loud: an SES refusal or an unreachable SES is returned as a failed send
 * (the route answers non-2xx), never retried through Postmark.
 */

export const SES_KEY_PROVIDER = "aws-ses-transactional";

/**
 * The unsubscribe link of our product mail. email-gateway appends a footer whose
 * link is Postmark's merge tag `{{{pm:unsubscribe}}}` (resolved by Postmark only).
 * On SES the same link becomes SES's own `{{amazonSESUnsubscribeUrl}}`, scoped to
 * this contact list (created once, 2026-11-19): SES serves the unsubscribe page,
 * adds List-Unsubscribe + one-click headers, and never mails an opted-out contact
 * again on this list. A mail with no such link carries no list (sign-up code).
 */
export const SES_PRODUCT_CONTACT_LIST = "distribute-product-mail";

/**
 * Every SES send names this configuration set: its event destination publishes
 * BOUNCE, COMPLAINT, DELIVERY and SUBSCRIPTION (list unsubscribe) to the SNS topic
 * `SES_EVENTS_TOPIC_ARN`, which posts to `POST /webhooks/ses` (ses-events.ts).
 * Created by `scripts/setup-ses-events.ts` (idempotent). Missing set = SES refuses
 * the send (fail loud), never a send whose bounces nobody hears.
 */
export const SES_EVENTS_CONFIGURATION_SET = "distribute-product-mail-events";
export const SES_EVENTS_TOPIC_NAME = "ses-product-mail-events";
/** Account 030693215272 = SES account `distribute-transactional`, us-east-1. */
export const SES_EVENTS_TOPIC_ARN = `arn:aws:sns:us-east-1:030693215272:${SES_EVENTS_TOPIC_NAME}`;

/**
 * The two SES accounts we send from. Each has its OWN credentials, contact list
 * (unsubscribe), configuration set and SNS topic (events). Never mixed: the
 * transactional account is declared TRANSACTIONAL (product mail only), the
 * marketing one MARKETING (the newsletter, SES-NEWSLETTER-1119).
 */
export interface SesAccount {
  name: "transactional" | "marketing";
  keyProvider: string;
  contactList: string;
  configurationSet: string;
  topicName: string;
  topicArn: string;
}

export const SES_TRANSACTIONAL: SesAccount = {
  name: "transactional",
  keyProvider: SES_KEY_PROVIDER,
  contactList: SES_PRODUCT_CONTACT_LIST,
  configurationSet: SES_EVENTS_CONFIGURATION_SET,
  topicName: SES_EVENTS_TOPIC_NAME,
  topicArn: SES_EVENTS_TOPIC_ARN,
};

/** Account 168197326881 = SES account `distribute-marketing`, us-east-1, identity news.distribute.you. */
export const SES_MARKETING: SesAccount = {
  name: "marketing",
  keyProvider: "aws-ses-marketing",
  contactList: "distribute-newsletter",
  configurationSet: "distribute-newsletter-events",
  topicName: "ses-newsletter-events",
  topicArn: "arn:aws:sns:us-east-1:168197326881:ses-newsletter-events",
};

export const SES_ACCOUNTS: SesAccount[] = [SES_TRANSACTIONAL, SES_MARKETING];

const POSTMARK_UNSUBSCRIBE_TAG = /\{\{\{\s*pm:unsubscribe\s*\}\}\}/g;
const SES_UNSUBSCRIBE_TAG = "{{amazonSESUnsubscribeUrl}}";

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** Parse the key-service value. Any missing field = throw (never a default region). */
export function parseSesCredentials(raw: string): SesCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`key-service ${SES_KEY_PROVIDER} is not JSON`);
  }
  const o = parsed as Record<string, unknown>;
  for (const field of ["accessKeyId", "secretAccessKey", "region"] as const) {
    if (typeof o[field] !== "string" || !(o[field] as string).trim()) {
      throw new Error(`key-service ${SES_KEY_PROVIDER} has no ${field}`);
    }
  }
  return {
    accessKeyId: (o.accessKeyId as string).trim(),
    secretAccessKey: (o.secretAccessKey as string).trim(),
    region: (o.region as string).trim(),
  };
}

// ─── SigV4 ───────────────────────────────────────────────────────────────────

/**
 * SigV4 canonical URI for every AWS service but S3: each path segment URI-encoded
 * AGAIN (a path carrying `%2B` signs as `%252B`). Plain paths are unchanged.
 */
export function canonicalUri(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20261119T101500Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Sign one AWS request (Signature Version 4). Returns the headers to send:
 * `host`, `x-amz-date`, `content-type`, `authorization`.
 */
export function signAwsRequest(params: {
  method: string;
  host: string;
  path: string;
  body: string;
  service: string;
  creds: SesCredentials;
  now: Date;
  contentType?: string;
}): Record<string, string> {
  const { method, host, path, body, service, creds, now } = params;
  const contentType = params.contentType ?? "application/json";
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": contentType,
    host,
    "x-amz-date": date,
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const canonicalRequest = [
    method,
    canonicalUri(path),
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    sha256Hex(body),
  ].join("\n");
  const scope = `${day}/${creds.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  };
}

// ─── Addresses ───────────────────────────────────────────────────────────────

/**
 * Split a Postmark-style address list (`a@x.com, "Doe, Jane" <j@y.com>`) into one
 * entry per address. Commas inside quotes or angle brackets do not split.
 */
export function splitAddressList(list: string | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of list) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(encodeDisplayName);
}

/**
 * SES refuses a raw non-ASCII display name: it must be an RFC 2047 encoded-word.
 * `Équipe <a@x.com>` → `=?UTF-8?B?w4lxdWlwZQ==?= <a@x.com>`. ASCII stays as is.
 */
export function encodeDisplayName(address: string): string {
  const m = address.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (!m) return address.trim();
  const name = m[1].replace(/^"(.*)"$/, "$1");
  // eslint-disable-next-line no-control-regex
  if (!name || /^[\x00-\x7F]*$/.test(name)) return address.trim();
  return `=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?= <${m[2].trim()}>`;
}

/** The bare address of `Name <a@x.com>` or `a@x.com`, lowercased. */
export function bareAddress(address: string): string {
  const m = address.match(/<([^<>]+)>/);
  return (m ? m[1] : address).trim().toLowerCase();
}

/** The domain of an address (`Name <a@Distribute.you>` → `distribute.you`). */
export function addressDomain(address: string): string {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf("@");
  return at >= 0 ? bare.slice(at + 1) : "";
}

// ─── Send ────────────────────────────────────────────────────────────────────

export interface SesSendParams {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  replyTo?: string;
  tag?: string;
  headers?: { name: string; value: string }[];
}

export interface SesSendResult {
  success: boolean;
  /** SES's own id; the delivered Message-ID header is `<id@email.amazonses.com>`. */
  sesMessageId?: string;
  /** The other SES messages of a split send (SES-BCC-1127), in send order. */
  copyMessageIds?: string[];
  submittedAt?: Date;
  errorCode?: number;
  message?: string;
}

/** The SESv2 SendEmail body for one message (pure, pinned by tests). */
export function buildSesSendBody(params: SesSendParams, account: SesAccount = SES_TRANSACTIONAL): Record<string, unknown> {
  const hasUnsubscribe = [params.htmlBody, params.textBody].some(
    (b) => b !== undefined && new RegExp(POSTMARK_UNSUBSCRIBE_TAG.source).test(b)
  );
  const swap = (b: string) => b.replace(POSTMARK_UNSUBSCRIBE_TAG, SES_UNSUBSCRIBE_TAG);
  const simple: Record<string, unknown> = {
    Subject: { Data: params.subject, Charset: "UTF-8" },
    Body: {
      ...(params.htmlBody !== undefined && { Html: { Data: swap(params.htmlBody), Charset: "UTF-8" } }),
      ...(params.textBody !== undefined && { Text: { Data: swap(params.textBody), Charset: "UTF-8" } }),
    },
  };
  if (params.headers && params.headers.length > 0) {
    simple.Headers = params.headers.map((h) => ({ Name: h.name, Value: h.value }));
  }
  const destination: Record<string, string[]> = { ToAddresses: splitAddressList(params.to) };
  const cc = splitAddressList(params.cc);
  const bcc = splitAddressList(params.bcc);
  if (cc.length > 0) destination.CcAddresses = cc;
  if (bcc.length > 0) destination.BccAddresses = bcc;
  const replyTo = splitAddressList(params.replyTo);
  return {
    FromEmailAddress: encodeDisplayName(params.from),
    Destination: destination,
    ...(replyTo.length > 0 && { ReplyToAddresses: replyTo }),
    Content: { Simple: simple },
    ConfigurationSetName: account.configurationSet,
    ...(hasUnsubscribe && { ListManagementOptions: { ContactListName: account.contactList } }),
    ...(params.tag && {
      EmailTags: [{ Name: "tag", Value: params.tag.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) }],
    }),
  };
}

/**
 * Every address a send names, To + Cc + Bcc (SES bills each one, and so does
 * Postmark: the ledger declares this many units).
 */
export function countRecipients(params: Pick<SesSendParams, "to" | "cc" | "bcc">): number {
  return splitAddressList(params.to).length + splitAddressList(params.cc).length + splitAddressList(params.bcc).length;
}

/**
 * The SES messages one send becomes (SES-BCC-1127). SES refuses
 * `ListManagementOptions` on a message with more than one recipient (400 « There
 * must be one Recipient when ListManagementOptions is set »): prod 2026-11-20..27,
 * 17 customer mails blind-copied to the agency inbox failed. So a send that carries
 * an unsubscribe link AND names several addresses becomes:
 *   - one message per To / Cc address, each with list management (every visible
 *     recipient keeps its own one-click unsubscribe, on its own contact);
 *   - ONE message to all Bcc addresses together, without list management and with
 *     the unsubscribe link emptied (a blind copy is our record of what the person
 *     read, never a subscriber of its own);
 *   - the FIRST To address last: it is the send's primary message, so a 2xx means
 *     the person the send is about got it.
 * Anything else (no unsubscribe link, or one recipient) = one message, unchanged.
 * Trade-off: each visible recipient sees only its own address in To/Cc.
 */
export function planSesMessages(params: SesSendParams, account: SesAccount = SES_TRANSACTIONAL): Record<string, unknown>[] {
  const single = buildSesSendBody(params, account);
  if (!single.ListManagementOptions || countRecipients(params) <= 1) return [single];
  const [primary, ...otherTo] = splitAddressList(params.to);
  const cc = splitAddressList(params.cc);
  const bcc = splitAddressList(params.bcc);
  const base = { ...params, to: "", cc: undefined, bcc: undefined };
  const withDestination = (body: Record<string, unknown>, destination: Record<string, string[]>) => ({
    ...body,
    Destination: destination,
  });
  const listed = buildSesSendBody({ ...base, to: primary }, account);
  const messages: Record<string, unknown>[] = [];
  if (bcc.length > 0) {
    const strip = (b: string | undefined) => (b === undefined ? undefined : b.replace(POSTMARK_UNSUBSCRIBE_TAG, ""));
    const copy = buildSesSendBody({ ...base, to: primary, htmlBody: strip(params.htmlBody), textBody: strip(params.textBody) }, account);
    messages.push(withDestination(copy, { BccAddresses: bcc }));
  }
  for (const a of otherTo) messages.push(withDestination(listed, { ToAddresses: [a] }));
  for (const a of cc) messages.push(withDestination(listed, { CcAddresses: [a] }));
  messages.push(listed);
  return messages;
}

/**
 * Send one message through SES (several SES calls when `planSesMessages` splits
 * it). Never throws: a refusal is a failed result. Calls run in order and stop at
 * the first refusal; the primary message goes last, so a failed send never reached
 * the person it is about. `sesMessageId` = the primary's id (events key on it);
 * `copyMessageIds` = the others' (their events are recognised, not recorded).
 */
export async function sesSendEmail(
  creds: SesCredentials,
  params: SesSendParams,
  account: SesAccount = SES_TRANSACTIONAL,
  now: Date = new Date()
): Promise<SesSendResult> {
  const messages = planSesMessages(params, account);
  const ids: string[] = [];
  for (const message of messages) {
    const result = await postSesMessage(creds, message, now);
    if (!result.success) {
      const partial = ids.length > 0 ? ` (after ${ids.length} of ${messages.length} copies went out: ${ids.join(", ")})` : "";
      return { ...result, message: `${result.message}${partial}` };
    }
    ids.push(result.sesMessageId!);
  }
  return {
    success: true,
    sesMessageId: ids[ids.length - 1],
    copyMessageIds: ids.slice(0, -1),
    submittedAt: new Date(),
    errorCode: 0,
    message: "OK",
  };
}

async function postSesMessage(creds: SesCredentials, message: Record<string, unknown>, now: Date): Promise<SesSendResult> {
  const host = `email.${creds.region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify(message);
  try {
    const headers = signAwsRequest({ method: "POST", host, path, body, service: "ses", creds, now });
    const response = await fetch(`https://${host}${path}`, { method: "POST", headers, body });
    const text = await response.text();
    if (!response.ok) {
      console.error(`[ses] SendEmail refused — status=${response.status} body=${text.slice(0, 500)}`);
      return { success: false, errorCode: response.status, message: `SES ${response.status}: ${text.slice(0, 500)}` };
    }
    const parsed = JSON.parse(text) as { MessageId?: string };
    if (!parsed.MessageId) {
      return { success: false, errorCode: -1, message: `SES answered without a MessageId: ${text.slice(0, 200)}` };
    }
    return { success: true, sesMessageId: parsed.MessageId, errorCode: 0, message: "OK" };
  } catch (error) {
    console.error("[ses] SendEmail error:", error);
    return { success: false, errorCode: -1, message: `SES unreachable: ${messageOf(error)}` };
  }
}

/**
 * One signed AWS call (SES v2 JSON, SES v1 / SNS query APIs). Used by the setup
 * and carry-over scripts; never throws on a non-2xx (the caller reads `status`).
 */
export async function awsRequest(
  creds: SesCredentials,
  req: { service: "ses" | "sns"; method: string; path: string; body?: string; contentType?: string }
): Promise<{ status: number; text: string }> {
  const host = req.service === "sns" ? `sns.${creds.region}.amazonaws.com` : `email.${creds.region}.amazonaws.com`;
  const body = req.body ?? "";
  const headers = signAwsRequest({
    method: req.method,
    host,
    path: req.path,
    body,
    service: req.service,
    creds,
    now: new Date(),
    contentType: req.contentType,
  });
  const response = await fetch(`https://${host}${req.path}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "DELETE" ? undefined : body,
  });
  return { status: response.status, text: await response.text() };
}
