import { createHash, createVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  postmarkSendings,
  postmarkDeliveries,
  postmarkBounces,
  postmarkSpamComplaints,
  postmarkSubscriptionChanges,
} from "../db/schema";
import { upsertSilver } from "./silver";
import { SES_ACCOUNTS } from "./ses-client";
import { getPlatformKey } from "./key-client";

/**
 * SES bounces, complaints, deliveries and list unsubscribes, recorded like
 * Postmark's (SES-EVENTS-1119). SES (configuration set
 * `distribute-product-mail-events`) → SNS topic `ses-product-mail-events` →
 * `POST /webhooks/ses`. Each event is written into the SAME bronze tables the
 * Postmark webhooks fill (postmark_bounces / _spam_complaints / _deliveries /
 * _subscription_changes, keyed on OUR message uuid found via
 * postmark_sendings.provider_message_id), then `upsertSilver`, so every reader
 * (silver bounced/delivered/unsubscribed, /orgs/status, stats) sees them with no
 * change. Rows carry `message_stream = 'ses'` and `metadata.provider = 'ses'`.
 *
 * Trust: an SNS message is accepted only if (1) its signature verifies against
 * the AWS certificate it names, fetched from an `sns.<region>.amazonaws.com` URL
 * only, and (2) its TopicArn is OUR topic exactly (anyone can point their own
 * SNS topic at a public URL, and SNS signs those too).
 */

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation" | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export function isAwsSnsUrl(raw: string | undefined, pathSuffix?: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && CERT_HOST.test(u.hostname) && (!pathSuffix || u.pathname.endsWith(pathSuffix));
  } catch {
    return false;
  }
}

/** The exact string SNS signs (AWS doc "Verifying the signatures of Amazon SNS messages"). */
export function snsStringToSign(m: SnsMessage): string {
  const keys =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join("");
}

const certCache = new Map<string, string>();

export function clearSnsCertCacheForTests(): void {
  certCache.clear();
}

async function fetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SNS signing cert ${url} answered ${r.status}`);
  const pem = await r.text();
  certCache.set(url, pem);
  return pem;
}

/** Throws with the reason when the message is not a genuine SNS message of OUR topic. */
export async function verifySnsMessage(
  m: SnsMessage,
  ourTopicArns: string[] = SES_ACCOUNTS.map((a) => a.topicArn)
): Promise<void> {
  if (!ourTopicArns.includes(m.TopicArn)) throw new Error(`topic ${m.TopicArn} is not ours`);
  if (!isAwsSnsUrl(m.SigningCertURL, ".pem")) throw new Error(`signing cert URL ${m.SigningCertURL} is not an AWS SNS URL`);
  const algorithm = m.SignatureVersion === "1" ? "RSA-SHA1" : m.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (!algorithm) throw new Error(`unknown SignatureVersion ${m.SignatureVersion}`);
  const pem = await fetchCert(m.SigningCertURL);
  const verifier = createVerify(algorithm);
  verifier.update(snsStringToSign(m), "utf8");
  if (!verifier.verify(pem, m.Signature, "base64")) throw new Error("SNS signature does not verify");
}

// ─── SES event → our bronze rows ─────────────────────────────────────────────

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail: { messageId: string; source?: string; destination?: string[]; timestamp?: string; commonHeaders?: { subject?: string } };
  bounce?: {
    bounceType: string;
    bounceSubType?: string;
    feedbackId: string;
    timestamp?: string;
    bouncedRecipients: { emailAddress: string; diagnosticCode?: string; status?: string; action?: string }[];
  };
  complaint?: { feedbackId: string; timestamp?: string; complaintFeedbackType?: string; complainedRecipients: { emailAddress: string }[] };
  delivery?: { timestamp?: string; recipients?: string[]; smtpResponse?: string };
  subscription?: { timestamp?: string; newTopicPreferences?: { unsubscribeAll?: boolean } };
}

/** Postmark's bounce Type names, so the bronze table reads one vocabulary. */
export function bounceTypeOf(sesBounceType: string): string {
  if (sesBounceType === "Permanent") return "HardBounce";
  if (sesBounceType === "Transient") return "SoftBounce";
  return "Undeterminable";
}

/**
 * postmark_bounces.id is Postmark's numeric bounce id. An SES bounce gets a
 * NEGATIVE id derived from (feedbackId, recipient): never collides with a
 * Postmark id, and an SNS redelivery lands on the same row (no duplicate).
 */
export function sesBounceId(feedbackId: string, recipient: string): number {
  const h = createHash("sha256").update(`${feedbackId}:${recipient.toLowerCase()}`).digest();
  return -(h.readUIntBE(0, 6) + 1);
}

const toDate = (s?: string) => (s ? new Date(s) : null);

export type SesEventOutcome = "recorded" | "unknown_message" | "ignored";

/** Record one SES event published through SNS. Throws on a DB error (SNS retries). */
export async function recordSesEvent(raw: string): Promise<SesEventOutcome> {
  const event = JSON.parse(raw) as SesEvent;
  const type = event.eventType ?? event.notificationType;
  const sesMessageId = event.mail?.messageId;
  if (!sesMessageId) throw new Error(`SES event ${type} carries no mail.messageId`);

  const [sending] = await db
    .select({ messageId: postmarkSendings.messageId, tag: postmarkSendings.tag, provider: postmarkSendings.provider })
    .from(postmarkSendings)
    .where(eq(postmarkSendings.providerMessageId, sesMessageId))
    .limit(1);
  if (!sending?.messageId) {
    console.error(`[ses-events] ${type} for SES message ${sesMessageId} matches no send of ours — not recorded`);
    return "unknown_message";
  }
  const messageId = sending.messageId;
  const metadata = { provider: "ses", sesMessageId };

  switch (type) {
    case "Bounce": {
      const b = event.bounce!;
      for (const r of b.bouncedRecipients) {
        await db
          .insert(postmarkBounces)
          .values({
            id: sesBounceId(b.feedbackId, r.emailAddress),
            recordType: "Bounce",
            type: bounceTypeOf(b.bounceType),
            name: `${b.bounceType}/${b.bounceSubType ?? ""}`,
            tag: sending.tag,
            messageId,
            description: b.bounceSubType ?? null,
            details: r.diagnosticCode ?? r.status ?? null,
            email: r.emailAddress,
            fromAddress: event.mail.source ?? null,
            bouncedAt: toDate(b.timestamp),
            inactive: b.bounceType === "Permanent",
            canActivate: false,
            subject: event.mail.commonHeaders?.subject ?? null,
            messageStream: "ses",
            metadata: { ...metadata, feedbackId: b.feedbackId },
          })
          .onConflictDoNothing();
      }
      await upsertSilver(messageId);
      if (sending.provider === "ses-marketing" && b.bounceType === "Permanent") {
        await mirrorOptOutToPostmark(b.bouncedRecipients.map((r) => r.emailAddress));
      }
      return "recorded";
    }
    case "Complaint": {
      const c = event.complaint!;
      await db
        .insert(postmarkSpamComplaints)
        .values({
          recordType: "SpamComplaint",
          messageStream: "ses",
          metadata: { ...metadata, feedbackId: c.feedbackId, complaintFeedbackType: c.complaintFeedbackType ?? null },
          messageId,
          tag: sending.tag,
          email: c.complainedRecipients[0]?.emailAddress ?? null,
          fromAddress: event.mail.source ?? null,
          bouncedAt: toDate(c.timestamp),
          subject: event.mail.commonHeaders?.subject ?? null,
        })
        .onConflictDoNothing();
      if (sending.provider === "ses-marketing") {
        await mirrorOptOutToPostmark(c.complainedRecipients.map((r) => r.emailAddress));
      }
      return "recorded";
    }
    case "Delivery": {
      const d = event.delivery!;
      await db
        .insert(postmarkDeliveries)
        .values({
          messageId,
          recordType: "Delivery",
          messageStream: "ses",
          recipient: (d.recipients ?? []).join(", ") || null,
          tag: sending.tag,
          deliveredAt: toDate(d.timestamp),
          details: d.smtpResponse ?? null,
          metadata,
        })
        .onConflictDoNothing();
      await upsertSilver(messageId);
      return "recorded";
    }
    case "Subscription": {
      const s = event.subscription!;
      await db
        .insert(postmarkSubscriptionChanges)
        .values({
          recordType: "SubscriptionChange",
          messageStream: "ses",
          metadata,
          messageId,
          tag: sending.tag,
          recipient: event.mail.destination?.[0] ?? null,
          origin: "Recipient",
          suppressSending: s.newTopicPreferences?.unsubscribeAll ?? true,
          changedAt: toDate(s.timestamp),
        })
        .onConflictDoNothing();
      await upsertSilver(messageId);
      if (sending.provider === "ses-marketing" && (s.newTopicPreferences?.unsubscribeAll ?? true)) {
        await mirrorOptOutToPostmark(event.mail.destination ?? []);
      }
      return "recorded";
    }
    default:
      console.warn(`[ses-events] event type ${type} not recorded (message ${sesMessageId})`);
      return "ignored";
  }
}

// ─── Newsletter opt-outs → Postmark's broadcast suppression list ─────────────

/**
 * transactional-email-service reads the newsletter's opt-out state from ONE place,
 * Postmark's broadcast-stream suppression list, before every slice it sends (its
 * suppression.ts). So an unsubscribe, hard bounce or complaint on an SES-sent
 * newsletter is written there too (a ManualSuppression), and the next send skips
 * the person whichever provider carries it. Fails loud: the SNS delivery answers
 * 500 and SNS retries (the bronze rows are idempotent).
 */
export async function mirrorOptOutToPostmark(emails: string[]): Promise<void> {
  const list = emails.map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) return;
  const caller = { method: "POST", path: "/webhooks/ses" };
  const token = await getPlatformKey("postmark", caller);
  const stream = await getPlatformKey("postmark-broadcast-stream", caller);
  const r = await fetch(`https://api.postmarkapp.com/message-streams/${encodeURIComponent(stream)}/suppressions`, {
    method: "POST",
    headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ Suppressions: list.map((EmailAddress) => ({ EmailAddress })) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Postmark suppression write ${r.status}: ${text.slice(0, 300)}`);
  const failed = ((JSON.parse(text) as { Suppressions?: { EmailAddress: string; Status: string; Message?: string }[] }).Suppressions ?? []).filter(
    (x) => x.Status !== "Suppressed"
  );
  if (failed.length > 0) throw new Error(`Postmark refused to suppress ${JSON.stringify(failed).slice(0, 300)}`);
  console.log(`[ses-events] newsletter opt-out mirrored to Postmark broadcast suppression: ${list.length} address(es)`);
}
