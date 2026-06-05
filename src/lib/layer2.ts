/**
 * Pure Layer 2 status computation. No DB, no I/O. Easily unit-testable in isolation
 * so tests don't require POSTMARK_SERVICE_DATABASE_URL.
 */

export interface Layer2Inputs {
  errorCode: number | null;
  hasDelivery: boolean;
  hasBounce: boolean;
  hasOpen: boolean;
  hasClick: boolean;
  hasUnsubscribe: boolean;
  deliveredAt: Date | null;
  // First-occurrence (MIN) raw event timestamps, null when the event never occurred.
  openFirstAt?: Date | null; // MIN(received_at) across Open webhooks
  clickFirstAt?: Date | null; // MIN(received_at) across Click webhooks
  bounceAt?: Date | null; // Bounce.bounced_at
  unsubAt?: Date | null; // SubscriptionChange.changed_at
}

export interface Layer2Result {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: Date | null;
  // Stored first-occurrence timestamps with implication baked in.
  // Each is non-null iff its corresponding boolean is true.
  firstOpenedAt: Date | null; // opened ? (open ?? click) : null
  firstClickedAt: Date | null; // clicked (never implied)
  firstBouncedAt: Date | null; // bounced
  firstUnsubscribedAt: Date | null; // unsubscribed
}

/**
 * Compute Layer 2 status from raw event presence flags.
 * Implication chain: contacted → sent → delivered → opened → clicked.
 *   - click forces opened, delivered (unless bounced), sent
 *   - open forces delivered (unless bounced), sent
 *   - bounce forces sent=true, delivered=false (even if a delivery webhook exists)
 *   - errorCode=0 alone gives sent=true
 *   - sending row existing gives contacted=true
 */
export function recomputeLayer2(inputs: Layer2Inputs): Layer2Result {
  const clicked = inputs.hasClick;
  const opened = inputs.hasOpen || clicked;
  const delivered = (inputs.hasDelivery || opened) && !inputs.hasBounce;
  const sent =
    inputs.errorCode === 0 ||
    inputs.hasDelivery ||
    opened ||
    clicked ||
    inputs.hasBounce;
  const contacted = true;

  // First-occurrence timestamps mirror the boolean implication chain so that
  // each first*At is non-null exactly when its boolean is true.
  // - clicked is never implied → firstClickedAt = the click time (or null).
  // - opened is implied by click → firstOpenedAt falls back to the click time
  //   when there is no Open webhook but a Click exists.
  const firstClickedAt = clicked ? inputs.clickFirstAt ?? null : null;
  const firstOpenedAt = opened
    ? inputs.openFirstAt ?? inputs.clickFirstAt ?? null
    : null;
  const firstBouncedAt = inputs.hasBounce ? inputs.bounceAt ?? null : null;
  const firstUnsubscribedAt = inputs.hasUnsubscribe ? inputs.unsubAt ?? null : null;

  return {
    contacted,
    sent,
    delivered,
    opened,
    clicked,
    bounced: inputs.hasBounce,
    unsubscribed: inputs.hasUnsubscribe,
    lastDeliveredAt: inputs.deliveredAt,
    firstOpenedAt,
    firstClickedAt,
    firstBouncedAt,
    firstUnsubscribedAt,
  };
}
