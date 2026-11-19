import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { getPlatformKey } from "./key-client";
import { awsRequest, parseSesCredentials, SES_MARKETING } from "./ses-client";

/**
 * Warm-up ramp of the newsletter on the brand-new MARKETING SES account
 * (SES-NEWSLETTER-1119, owner 2026-11-19 « mets sur SES »).
 *
 * Market practice for moving a list to a new sending account (AWS SES "warming
 * up", Mailgun / SendGrid / Validity migration guides): never send the whole list
 * on day one; start in the hundreds-to-low-thousands per day, roughly DOUBLE the
 * daily volume while bounce < 2 % and complaints < 0.1 %, and keep the old
 * provider carrying the rest until the new one carries all of it (2-3 weeks for a
 * cold IP; faster here: SES shared IPs are warm and news.distribute.you already
 * has its own DKIM reputation from Postmark). So:
 *
 *   cap(day d since RAMP_START) = min(RAMP_FIRST_DAY x 2^d, 80 % of SES's Max24HourSend)
 *   = 500, 1k, 2k, 4k, 8k, 16k, 32k, then the account quota (50k/day today).
 *
 * A newsletter send over today's cap stays on Postmark's broadcast stream: the
 * release keeps its pace (transactional-email-service paces and halts on bounce
 * rate itself), only the provider changes. Opt-outs stay whole either way:
 * Postmark's broadcast suppression list is the one transactional-email-service
 * reads, and every SES opt-out is mirrored into it (ses-events.ts).
 *
 * Counting: today's SES-marketing sends read from `postmark_sendings` once per
 * UTC day per process, then counted in memory (one container).
 */

export const RAMP_START = new Date("2026-11-19T00:00:00Z");
export const RAMP_FIRST_DAY = 500;
export const QUOTA_SHARE = 0.8;
const QUOTA_TTL_MS = 10 * 60_000;

/** Pure: the cap of a UTC day. */
export function rampCapFor(day: Date, max24HourSend: number): number {
  const d = Math.max(0, Math.floor((startOfUtcDay(day).getTime() - RAMP_START.getTime()) / 86_400_000));
  const schedule = RAMP_FIRST_DAY * 2 ** Math.min(d, 30);
  return Math.min(schedule, Math.floor(max24HourSend * QUOTA_SHARE));
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

let quota: { value: number; at: number } | null = null;
let used: { day: number; count: number } | null = null;

export function resetMarketingRampForTests(): void {
  quota = null;
  used = null;
}

/** SES's own 24-hour quota of the marketing account. Throws if unreadable (fail loud). */
async function max24HourSend(now: number): Promise<number> {
  if (quota && now - quota.at < QUOTA_TTL_MS) return quota.value;
  const creds = parseSesCredentials(
    await getPlatformKey(SES_MARKETING.keyProvider, { method: "GET", path: "/marketing-ramp" })
  );
  const r = await awsRequest(creds, { service: "ses", method: "GET", path: "/v2/email/account" });
  if (r.status !== 200) throw new Error(`SES marketing GetAccount ${r.status}: ${r.text.slice(0, 200)}`);
  const value = (JSON.parse(r.text) as { SendQuota?: { Max24HourSend?: number } }).SendQuota?.Max24HourSend;
  if (typeof value !== "number") throw new Error("SES marketing GetAccount carries no SendQuota.Max24HourSend");
  quota = { value, at: now };
  return value;
}

/** True = this newsletter send may go through SES; counted as used when true. */
export async function marketingRampAllows(now: Date = new Date()): Promise<boolean> {
  const day = startOfUtcDay(now).getTime();
  if (!used || used.day !== day) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(postmarkSendings)
      .where(and(eq(postmarkSendings.provider, "ses-marketing"), gte(postmarkSendings.createdAt, new Date(day))));
    used = { day, count: row?.n ?? 0 };
  }
  const cap = rampCapFor(now, await max24HourSend(now.getTime()));
  if (used.count >= cap) {
    console.log(`[marketing-ramp] today's SES cap ${cap} reached (${used.count} sent): this newsletter send stays on Postmark`);
    return false;
  }
  used.count++;
  return true;
}
