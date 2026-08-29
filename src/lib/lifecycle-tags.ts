/**
 * Platform lifecycle / account emails. These are platform-initiated (the platform
 * sends them — they are NOT customer-value delivery), so the platform pays for them:
 * `resolvePayer` (src/lib/payer.ts) reads this set as its backstop and returns
 * `platform`, which both skips the credit gate and declares the spend on an org-less
 * platform run instead of the org's run. A brand-new org sits at $0, and
 * billing-service cold-start cascades can 502 — both would otherwise block these
 * sends. The spend is still declared and still priced; it just is not the org's.
 * The tag is the eventType set by transactional-email-service (`tag: eventType`).
 *
 * This set is a BACKSTOP, not the mechanism. `tag` is a free-form eventType read out
 * of transactional-email-service's own `email_templates` table, so a list of them
 * kept here can never be complete — it goes stale silently every time a template is
 * added over there, and the stale entry fails in the billed direction. Callers should
 * send `payer: "platform"` on the send request; this set covers the mails that
 * predate the field.
 *
 * The billing-notification family below is load-bearing beyond "a $0 org can still be
 * mailed": authorizing credits for one of these mails re-enters billing-service's
 * charge path, and these are exactly the mails sent BECAUSE that path just failed.
 * Prod 2026-08-29, org b645207b-…: `credits-reload-failed` was billed to the org, so
 * sending it authorized credits, which made billing retry the declined card, which
 * produced another `credits-reload-failed` — 2,939 authorizations and 2,938 declined
 * charges in 71 minutes, ~1 per 1.5s, until the card went to a flat generic_decline.
 * Only `credit-depleted` was exempt at the time; its five dunning siblings and the
 * reload-failure notification were not.
 *
 * A notification about the org's billing state must never be able to move that state.
 * Adding a billing/dunning eventType in billing-service means either sending
 * `payer: "platform"` from that send path or adding the tag here —
 * `tests/unit/billing-auth-gate.test.ts` pins the family.
 */
export const PLATFORM_LIFECYCLE_TAGS = new Set([
  // Account lifecycle
  "welcome",
  "signup_notification",
  "signin_notification",
  "user_active",
  "waitlist",
  // Billing notifications — see the note above; these report on the charge path,
  // so billing them to the org lets the report re-trigger what it reports on.
  "credits-reload-failed",
  "credit-depleted",
  "credit-depleted-followup-3d",
  "credit-depleted-followup-10d",
  "credit-depleted-blocked",
  "credit-depleted-followup-3d-blocked",
  "credit-depleted-followup-10d-blocked",
]);

/** True when this send is a platform lifecycle mail and must skip the credit gate. */
export function isPlatformLifecycleTag(tag: string | null | undefined): boolean {
  return tag != null && PLATFORM_LIFECYCLE_TAGS.has(tag);
}
