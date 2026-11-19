import { randomUUID } from "node:crypto";
import { getPlatformKey, CallerContext } from "./key-client";
import { addressDomain, parseSesCredentials, sesSendEmail, SesSendParams, SES_KEY_PROVIDER } from "./ses-client";
import type { SendEmailResult } from "./postmark-client";

/**
 * Which provider carries a send (SES-PLATFORM-SENDS-1119, owner 2026-11-19:
 * « Yes switch all that we can on SES »; SES and Postmark measured identical on our
 * seed mailboxes, Gmail 30/30 inbox each, DMARC pass; SES costs less).
 *
 * SES carries a send iff BOTH:
 *  1. it is paid with the PLATFORM Postmark key (keySource "platform"). An org's
 *     own Postmark key (BYOK) is the org's choice of provider: never moved.
 *  2. its From is on `distribute.you` itself, the one domain our SES identity
 *     covers and our own product mail uses (sign-up codes, welcome, receipts,
 *     billing notices, staff alerts). The newsletter leaves from
 *     `news.distribute.you` and stays on Postmark's broadcast stream: the SES
 *     account is declared TRANSACTIONAL only, marketing must never go through it.
 *     Any other domain (a client's) has no SES identity: Postmark, unchanged.
 *
 * Not the stream: our product mail goes out on Postmark's broadcast stream today
 * (measured 2026-11-19: 486 of the 499 product mails of 30 days), so a
 * "transactional stream only" rule would have moved 13 sign-up codes and nothing else.
 *
 * Kill switch, read at every send: `PLATFORM_SEND_PROVIDER=postmark` puts every one
 * of these sends back on Postmark (env file edit + container recreate, no code
 * deploy). Unset or `ses` = SES. Any other value = the send fails loud. An SES
 * error is a failed send, never a silent retry through Postmark.
 */

export type SendTransport = "postmark" | "ses";

/** The only From domain SES carries (our verified SES domain identity). */
export const SES_FROM_DOMAIN = "distribute.you";

export const KILL_SWITCH_ENV = "PLATFORM_SEND_PROVIDER";

/** The kill switch, read now. Throws on an unknown value (never guessed). */
export function platformSendProvider(env: NodeJS.ProcessEnv = process.env): SendTransport {
  const raw = (env[KILL_SWITCH_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "ses") return "ses";
  if (raw === "postmark") return "postmark";
  throw new Error(`${KILL_SWITCH_ENV}="${env[KILL_SWITCH_ENV]}" is neither "ses" nor "postmark"`);
}

export function chooseSendTransport(
  params: { keySource: "platform" | "org"; from: string },
  env: NodeJS.ProcessEnv = process.env
): SendTransport {
  if (params.keySource !== "platform") return "postmark";
  if (addressDomain(params.from) !== SES_FROM_DOMAIN) return "postmark";
  return platformSendProvider(env);
}

/** The cost name a send's run declares (and billing authorizes), per provider. */
export function costNameFor(transport: SendTransport): string {
  return transport === "ses" ? "ses-email-send" : "postmark-email-send";
}

export interface SesDeliveryResult extends SendEmailResult {
  /** SES's own MessageId (success only). `messageId` is OUR uuid for the row. */
  providerMessageId?: string;
}

/**
 * Send one message through SES with the platform credentials. On success the row
 * gets a uuid WE mint as `messageId` (every uuid read keeps working) and SES's id
 * as `providerMessageId`. Never throws for an SES refusal; throws if the key
 * cannot be read (the route answers 500, nothing was sent).
 */
export async function deliverViaSes(params: SesSendParams, caller: CallerContext): Promise<SesDeliveryResult> {
  const creds = parseSesCredentials(await getPlatformKey(SES_KEY_PROVIDER, caller));
  const result = await sesSendEmail(creds, params);
  if (!result.success) {
    return { success: false, errorCode: result.errorCode, message: result.message };
  }
  return {
    success: true,
    messageId: randomUUID(),
    providerMessageId: result.sesMessageId,
    submittedAt: result.submittedAt,
    errorCode: 0,
    message: result.message,
  };
}
