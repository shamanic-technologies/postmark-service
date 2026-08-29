import { isPlatformLifecycleTag } from "./lifecycle-tags";

/**
 * Who is charged for a send.
 *
 * - `org`      — work done on the customer's behalf. The cost is declared on the
 *                org's run, so runs-service counts it in that org's usage total
 *                (`is_platform_projected AND organization_id = <org>`) and
 *                billing-service charges it.
 * - `platform` — a platform-initiated notification (the platform decided to send
 *                it; the customer did not ask for it). The cost is declared on an
 *                ORG-LESS platform run, so `runs_costs.organization_id` is NULL and
 *                no org-spend SUM can ever pick it up. The spend is still declared
 *                and still priced — the platform absorbs it.
 *
 * There is no third value. A send that is not classified as platform is billed to
 * the org, which is the revenue-safe direction and is what every product send is.
 */
export type Payer = "platform" | "org";

/**
 * Resolve the payer for one send.
 *
 * Precedence, highest first:
 *
 * 1. **The caller says so.** `payer` on the request body. Only the service that
 *    decided to send the mail knows whether it was platform-initiated, so that
 *    service is the one place the classification can be correct. Callers are
 *    internal services behind service-key auth.
 * 2. **The tag is a known platform lifecycle tag.** A closed set maintained here
 *    (`PLATFORM_LIFECYCLE_TAGS`) covering the mails that existed before the field
 *    did. This is a backstop, not the mechanism: `tag` is the free-form eventType
 *    transactional-email-service reads out of its own `email_templates` table, so
 *    the set here can never be complete by construction — it goes stale silently
 *    every time a template is added over there. That staleness is exactly what
 *    produced the 2026-08-29 authorization storm (`credits-reload-failed` was a
 *    billing notification that no one had listed). Callers should send `payer`.
 * 3. **Otherwise, the org pays.** Product traffic, and anything unrecognised.
 */
export function resolvePayer(send: {
  payer?: Payer | null;
  tag?: string | null;
}): Payer {
  if (send.payer) return send.payer;
  if (isPlatformLifecycleTag(send.tag)) return "platform";
  return "org";
}
