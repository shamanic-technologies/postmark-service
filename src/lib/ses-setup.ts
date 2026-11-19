import { getPlatformKey } from "./key-client";
import {
  awsRequest,
  parseSesCredentials,
  SesCredentials,
  SES_EVENTS_CONFIGURATION_SET,
  SES_EVENTS_TOPIC_ARN,
  SES_EVENTS_TOPIC_NAME,
  SES_KEY_PROVIDER,
  SES_PRODUCT_CONTACT_LIST,
} from "./ses-client";

/**
 * One-shot, idempotent SES/SNS configuration and the Postmark → SES carry-over of
 * opted-out addresses (SES-EVENTS-1119). Run from the container:
 *   npx tsx scripts/setup-ses-events.ts
 *   npx tsx scripts/carry-postmark-suppressions-to-ses.ts [--apply]
 */

export const SES_EVENTS_ENDPOINT = "https://postmark.distribute.you/webhooks/ses";
const CALLER = { method: "POST", path: "/scripts/ses-setup" };

async function creds(): Promise<SesCredentials> {
  return parseSesCredentials(await getPlatformKey(SES_KEY_PROVIDER, CALLER));
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function sns(c: SesCredentials, params: Record<string, string>): Promise<string> {
  const r = await awsRequest(c, {
    service: "sns",
    method: "POST",
    path: "/",
    body: form({ ...params, Version: "2010-03-31" }),
    contentType: "application/x-www-form-urlencoded",
  });
  if (r.status !== 200) throw new Error(`SNS ${params.Action} ${r.status}: ${r.text.slice(0, 300)}`);
  return r.text;
}

/** Topic (signature v2, SES may publish), configuration set, event destination, HTTPS subscription. */
export async function setupSesEvents(): Promise<string[]> {
  const c = await creds();
  const log: string[] = [];
  await sns(c, { Action: "CreateTopic", Name: SES_EVENTS_TOPIC_NAME });
  await sns(c, { Action: "SetTopicAttributes", TopicArn: SES_EVENTS_TOPIC_ARN, AttributeName: "SignatureVersion", AttributeValue: "2" });
  const account = SES_EVENTS_TOPIC_ARN.split(":")[4];
  await sns(c, {
    Action: "SetTopicAttributes",
    TopicArn: SES_EVENTS_TOPIC_ARN,
    AttributeName: "Policy",
    AttributeValue: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ses-publishes-product-mail-events",
          Effect: "Allow",
          Principal: { Service: "ses.amazonaws.com" },
          Action: "SNS:Publish",
          Resource: SES_EVENTS_TOPIC_ARN,
          Condition: { StringEquals: { "AWS:SourceAccount": account } },
        },
      ],
    }),
  });
  log.push(`topic ${SES_EVENTS_TOPIC_ARN} ready (signature v2, SES may publish)`);

  const cs = await awsRequest(c, {
    service: "ses",
    method: "POST",
    path: "/v2/email/configuration-sets",
    body: JSON.stringify({ ConfigurationSetName: SES_EVENTS_CONFIGURATION_SET }),
  });
  if (cs.status !== 200 && !/AlreadyExists/.test(cs.text)) throw new Error(`CreateConfigurationSet ${cs.status}: ${cs.text}`);
  log.push(`configuration set ${SES_EVENTS_CONFIGURATION_SET} ${cs.status === 200 ? "created" : "already there"}`);

  const destination = {
    Enabled: true,
    MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY", "SUBSCRIPTION"],
    SnsDestination: { TopicArn: SES_EVENTS_TOPIC_ARN },
  };
  const destPath = `/v2/email/configuration-sets/${SES_EVENTS_CONFIGURATION_SET}/event-destinations`;
  const ed = await awsRequest(c, {
    service: "ses",
    method: "POST",
    path: destPath,
    body: JSON.stringify({ EventDestinationName: "sns-product-mail-events", EventDestination: destination }),
  });
  if (ed.status !== 200) {
    if (!/AlreadyExists/.test(ed.text)) throw new Error(`CreateEventDestination ${ed.status}: ${ed.text}`);
    const up = await awsRequest(c, {
      service: "ses",
      method: "PUT",
      path: `${destPath}/sns-product-mail-events`,
      body: JSON.stringify({ EventDestination: destination }),
    });
    if (up.status !== 200) throw new Error(`UpdateEventDestination ${up.status}: ${up.text}`);
  }
  log.push(`event destination BOUNCE/COMPLAINT/DELIVERY/SUBSCRIPTION → SNS`);

  const sub = await sns(c, {
    Action: "Subscribe",
    TopicArn: SES_EVENTS_TOPIC_ARN,
    Protocol: "https",
    Endpoint: SES_EVENTS_ENDPOINT,
    ReturnSubscriptionArn: "true",
  });
  log.push(`subscription ${SES_EVENTS_ENDPOINT}: ${(sub.match(/<SubscriptionArn>(.*?)<\/SubscriptionArn>/) ?? [])[1]}`);
  return log;
}

// ─── Postmark → SES carry-over of opted-out addresses ────────────────────────

export interface PostmarkSuppression {
  EmailAddress: string;
  SuppressionReason: string; // HardBounce | SpamComplaint | ManualSuppression
  Origin: string;
}

export interface CarryPlan {
  /** Opted out on SES's product-mail contact list (every mail with an unsubscribe link). */
  contactOptOuts: string[];
  /** On SES's account-level suppression list (every SES send, sign-up codes included). */
  accountSuppressions: { email: string; reason: "BOUNCE" | "COMPLAINT" }[];
}

/**
 * Same reach as on Postmark, stream by stream:
 * - broadcast stream (where our product mail with an unsubscribe footer rode):
 *   blocked from those mails → opted out of the SES product-mail contact list,
 *   which gates exactly those mails. They still get a sign-up code, as on Postmark
 *   (codes rode the separate transactional stream).
 * - transactional ("outbound") stream (sign-up codes): blocked from everything we
 *   send there → SES account suppression (BOUNCE for a hard bounce, COMPLAINT for a
 *   spam complaint or a manual suppression: SES has no third reason).
 */
export function planSuppressionCarry(
  dumps: { stream: string; type: "Broadcasts" | "Transactional"; suppressions: PostmarkSuppression[] }[]
): CarryPlan {
  const optOuts = new Set<string>();
  const account = new Map<string, "BOUNCE" | "COMPLAINT">();
  for (const d of dumps) {
    for (const s of d.suppressions) {
      const email = s.EmailAddress.trim().toLowerCase();
      if (!email) continue;
      if (d.type === "Broadcasts") optOuts.add(email);
      else account.set(email, s.SuppressionReason === "HardBounce" ? "BOUNCE" : "COMPLAINT");
    }
  }
  return {
    contactOptOuts: [...optOuts].sort(),
    accountSuppressions: [...account].map(([email, reason]) => ({ email, reason })).sort((a, b) => a.email.localeCompare(b.email)),
  };
}

async function postmarkDumps(): Promise<Parameters<typeof planSuppressionCarry>[0]> {
  const token = await getPlatformKey("postmark", CALLER);
  const headers = { "X-Postmark-Server-Token": token, Accept: "application/json" };
  const streams = (await (await fetch("https://api.postmarkapp.com/message-streams", { headers })).json()) as {
    MessageStreams: { ID: string; MessageStreamType: string }[];
  };
  const out: Parameters<typeof planSuppressionCarry>[0] = [];
  for (const s of streams.MessageStreams) {
    if (s.MessageStreamType !== "Broadcasts" && s.MessageStreamType !== "Transactional") continue;
    const r = await fetch(`https://api.postmarkapp.com/message-streams/${s.ID}/suppressions/dump`, { headers });
    if (!r.ok) throw new Error(`Postmark suppressions dump ${s.ID} ${r.status}`);
    const d = (await r.json()) as { Suppressions: PostmarkSuppression[] };
    out.push({ stream: s.ID, type: s.MessageStreamType, suppressions: d.Suppressions ?? [] });
  }
  return out;
}

async function sesWithRetry(c: SesCredentials, req: Parameters<typeof awsRequest>[1]) {
  for (let attempt = 0; ; attempt++) {
    const r = await awsRequest(c, req);
    if (r.status !== 429 || attempt >= 8) return r;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}

export async function carryPostmarkSuppressionsToSes(apply: boolean) {
  const dumps = await postmarkDumps();
  const plan = planSuppressionCarry(dumps);
  const report = {
    postmark: dumps.map((d) => ({ stream: d.stream, type: d.type, suppressed: d.suppressions.length })),
    contactOptOuts: plan.contactOptOuts.length,
    accountSuppressions: plan.accountSuppressions.length,
    applied: apply,
    contactsWritten: 0,
    suppressionsWritten: 0,
  };
  if (!apply) return report;
  const c = await creds();
  const listPath = `/v2/email/contact-lists/${SES_PRODUCT_CONTACT_LIST}/contacts`;
  for (const email of plan.contactOptOuts) {
    const created = await sesWithRetry(c, { service: "ses", method: "POST", path: listPath, body: JSON.stringify({ EmailAddress: email, UnsubscribeAll: true }) });
    if (created.status !== 200) {
      if (!/AlreadyExists/.test(created.text)) throw new Error(`CreateContact ${email} ${created.status}: ${created.text}`);
      const up = await sesWithRetry(c, { service: "ses", method: "PUT", path: `${listPath}/${encodeURIComponent(email)}`, body: JSON.stringify({ UnsubscribeAll: true }) });
      if (up.status !== 200) throw new Error(`UpdateContact ${email} ${up.status}: ${up.text}`);
    }
    report.contactsWritten++;
  }
  for (const s of plan.accountSuppressions) {
    const r = await sesWithRetry(c, { service: "ses", method: "PUT", path: "/v2/email/suppression/addresses", body: JSON.stringify({ EmailAddress: s.email, Reason: s.reason }) });
    if (r.status !== 200) throw new Error(`PutSuppressedDestination ${s.email} ${r.status}: ${r.text}`);
    report.suppressionsWritten++;
  }
  return report;
}
